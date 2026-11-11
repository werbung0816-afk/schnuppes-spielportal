/* ChartsterOnTime Mobil – Spiellogik des Gastgebers.
   1:1 aus der NAS-Version (cot_app.py, v0.7.2) übertragen: Was dort der NAS gerechnet hat, rechnet hier das
   Gastgeber-Gerät. Die anderen Geräte schicken ihre Anfragen über Firebase, der Gastgeber beantwortet sie und
   veröffentlicht den Spielstand (für Handys ohne Lösung, für die Anzeige mit Lösung).
   Schritt 1: Raum, Spieler, Lobby, Auswahl und Ziel. Spielrunden folgen in Schritt 2. */
'use strict';

const COT = (() => {
  const VERSION = '0.1.0';

  // ── aus Chartster / NAS-Version ──
  const COLORS = ['#53f6ff', '#ff4fd8', '#8f5fff', '#4dff91', '#ffd84d', '#ff6b35'];
  const MAX_PLAYERS = 6;
  const DECADES = ['70er', '80er', '90er', '00er', '10er', '20er'];
  const EDITIONS = ['RS-500', 'Bond-Edition', 'WM-Edition', 'Popcorn-Edition', 'XMas-Edition'];
  const TARGETS = [7, 10, 15];
  const OFFLINE_AFTER = 8;                       // Sekunden ohne Lebenszeichen → Spieler gilt als weg

  const now = () => Date.now() / 1000;

  /* Öffentliche Kennung eines Geräts (die Geräte-ID selbst bleibt geheim): FNV-1a, 8 Hex-Zeichen */
  function pidId(pid){
    let h = 0x811c9dc5;
    for (let i = 0; i < pid.length; i++) { h ^= pid.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // =================================================================== Songs (Chartster)
  const Songs = {
    songs: [], loaded: false, failed: false,
    async load(url){
      try {
        const r = await fetch(url, { cache: 'no-cache' });
        const data = await r.json();
        this.songs = data.filter(s => s.l);                    // wie Chartster: nur Songs mit Spotify-ID
        this.loaded = true;
      } catch (e) { this.failed = true; }
    },
    /* Filterlogik 1:1 aus Chartster filteredSongs() bzw. NAS Songs.filtered() */
    filtered(excluded, top){
      let s = this.songs.filter(known);
      const ex = new Set(excluded || []);
      if (!ex.size && !top) return s;
      if (ex.size) {
        s = s.filter(x => !x.legacy);                          // Legacy-Songs nur, wenn nichts abgewählt
        s = s.filter(x => ![...ex].some(f => hit(x, f)));
      }
      if (top === 'top10') s = s.filter(x => x.p && x.p <= 10);
      else if (top === 'top20') s = s.filter(x => x.p && x.p <= 20);
      return s;
    }
  };
  // Nur bekannte Jahrzehnte/Editionen: 60er und künftige neue Editionen ohne Kachel sind immer abgewählt
  function known(x){
    if (x.f) return DECADES.includes(x.f) || EDITIONS.includes(x.f);
    const y = +x.y || 0;
    return y === 0 || y >= 1970;
  }
  function hit(x, f){
    if (x.f) return x.f === f;
    const y = +x.y || 0;
    return ({ '70er': y >= 1970 && y < 1980, '80er': y >= 1980 && y < 1990, '90er': y >= 1990 && y < 2000,
              '00er': y >= 2000 && y < 2010, '10er': y >= 2010 && y < 2020, '20er': y >= 2020 })[f] || false;
  }

  // =================================================================== Spiel
  class Game {
    /* io: { save(stateJson), log(text), urls: { game, tv }, room } */
    constructor(io){
      this.io = io;
      this.phase = 'lobby';                                    // lobby → question → reveal → … → won
      this.players = [];                                       // {pid, name, color, score, admin}
      this.seen = {};                                          // pid → letztes Lebenszeichen (Sekunden)
      this.settings = { excluded: ['70er', '80er', ...EDITIONS], top: null, target: 10 };   // 90er bis heute, Ziel 10
      this.rev = 0;
      this.round = 0;
      this.winners = [];
    }

    // ---------------------------------------------------------- Speichern / Laden (Firebase statt zustand.json)
    load(state){
      if (!state) return;
      try {
        const d = typeof state === 'string' ? JSON.parse(state) : state;
        this.players = (d.players || []).filter(p => p.pid && p.name).slice(0, MAX_PLAYERS);
        if (d.settings) Object.assign(this.settings, d.settings);
        if (!TARGETS.includes(this.settings.target)) this.settings.target = 10;
        this.phase = d.phase || 'lobby';
        this.round = d.round || 0;
        this.winners = d.winners || [];
        this.io.log(`[Spiel] Zustand geladen: ${this.players.length} Spieler`);
      } catch (e) { this.io.log('[Spiel] Zustand nicht lesbar: ' + e.message); }
    }
    dump(){
      return JSON.stringify({ players: this.players, settings: this.settings, phase: this.phase, round: this.round,
                              winners: this.winners });
    }
    _save(){
      this.rev++;
      this.io.save(this.dump());
    }

    // ---------------------------------------------------------- Spieler
    player(pid){ return this.players.find(p => p.pid === pid) || null; }
    isAdmin(pid){ const p = this.player(pid); return !!(p && p.admin); }

    join(pid, name, admin){
      name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      if (!pid || pid.length > 64) throw new Error('Ungültiges Gerät');
      if (!name) throw new Error('Bitte einen Namen eingeben');
      const other = this.players.find(p => p.name.toLowerCase() === name.toLowerCase() && p.pid !== pid);
      if (other && this.online(other.pid)) throw new Error(`„${other.name}“ spielt schon mit – bitte anderen Namen wählen`);
      let me = this.player(pid);
      if (other) {
        // Name gehört einem Gerät, das gerade nicht verbunden ist → dieses Gerät übernimmt den Eintrag (Farbe, Punkte, Admin)
        if (me) {
          other.admin = other.admin || me.admin || false;
          this.players.splice(this.players.indexOf(me), 1);
        }
        this._movePid(other, pid);
        this.io.log(`[Spiel] ${other.name} spielt auf einem anderen Gerät weiter`);
        me = other; name = other.name;                         // Schreibweise bleibt (Dani, nicht dani)
      }
      if (!me) {
        if (this.players.length >= MAX_PLAYERS) throw new Error(`Spiel ist voll – höchstens ${MAX_PLAYERS} Spieler`);
        const used = new Set(this.players.map(p => p.color));
        me = { pid, name, color: COLORS.find(c => !used.has(c)), score: 0, admin: false };
        this.players.push(me);
        this.io.log(`[Spiel] ${name} ist dabei (${this.players.length}/${MAX_PLAYERS})`);
      } else if (me.name !== name) {
        this.io.log(`[Spiel] ${me.name} heißt jetzt ${name}`);
        me.name = name;
      }
      if (admin && !me.admin) {                                // es gibt genau einen Admin
        this.players.forEach(p => { p.admin = false; });
        me.admin = true;
      }
      this.seen[pid] = now();
      this._save();
      return {};
    }
    _movePid(p, nw){
      delete this.seen[p.pid];
      p.pid = nw;
    }
    touch(pid){
      if (pid && this.player(pid)) {
        const wasOff = now() - (this.seen[pid] || 0) > OFFLINE_AFTER;
        this.seen[pid] = now();
        if (wasOff) this.rev++;
      }
    }
    online(pid){ return now() - (this.seen[pid] || 0) <= OFFLINE_AFTER; }

    // ---------------------------------------------------------- Einstellungen (Admin)
    setSettings(d){
      if ('excluded' in d) {
        const ex = (d.excluded || []).filter(f => DECADES.includes(f) || EDITIONS.includes(f));
        this.settings.excluded = [...new Set(ex)];
      }
      if ('top' in d) this.settings.top = (d.top === 'top10' || d.top === 'top20') ? d.top : null;
      if ('target' in d) {
        if (!TARGETS.includes(+d.target)) throw new Error('Ziel muss 7, 10 oder 15 sein');
        this.settings.target = +d.target;
      }
      this._save();
      return {};
    }
    pool(){ return Songs.filtered(this.settings.excluded, this.settings.top); }

    // ---------------------------------------------------------- Admin-Befehle
    start(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin kann starten');
      throw new Error('Die Spielrunden kommen mit Schritt 2.');
    }

    // ---------------------------------------------------------- Anfragen der Geräte (wie die Flask-Routen)
    handle(path, body){
      body = body || {};
      const pid = String(body.pid || '');
      if (path === '/api/join') return this.join(pid, body.name, !!body.admin && this.isHostPid(pid));
      if (path === '/api/admin/settings') {
        if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
        return this.setSettings(body);
      }
      if (path.startsWith('/api/admin/')) {
        if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
        const cmd = path.slice(11);
        if (cmd === 'start') return this.start(pid);
        throw new Error('Kommt mit Schritt 2');
      }
      throw new Error('Unbekannte Anfrage');
    }
    isHostPid(pid){ return pid === this.io.hostPid(); }

    // ---------------------------------------------------------- Zustand für alle Geräte
    /* tv=true: Anzeige – bekommt später Foto und Auflösung. Handys: nur Antworten und das eigene Ergebnis. */
    view(pid, tv){
      const pool = this.pool();
      const admin = this.isAdmin(pid);
      const out = {
        v: VERSION, rev: this.rev, phase: this.phase, round: this.round,
        players: this.players.map(p => ({ id: pidId(p.pid), name: p.name, color: p.color, score: p.score, admin: !!p.admin,
                                          online: this.online(p.pid), me: p.pid === pid, answered: false, gain: 0 })),
        maxPlayers: MAX_PLAYERS,
        settings: this.settings,
        songs: { pool: pool.length, total: Songs.songs.length, found: Songs.loaded, loading: !Songs.loaded && !Songs.failed },
        gameUrl: this.io.urls.game, tvUrl: this.io.urls.tv, room: this.io.room, wifi: ''
      };
      if (admin && this.phase === 'lobby') { out.next = null; out.hasNext = false; }
      return out;
    }
  }

  return { VERSION, Game, Songs, pidId, DECADES, EDITIONS };
})();
