/* ChartsterOnTime Mobil – Spiellogik des Gastgebers.
   1:1 aus der NAS-Version (cot_app.py, v0.7.2) übertragen: Was dort der NAS gerechnet hat, rechnet hier das
   Gastgeber-Gerät. Die anderen Geräte schicken ihre Anfragen über Firebase, der Gastgeber beantwortet sie und
   veröffentlicht den Spielstand (für Handys ohne Lösung, für die Anzeige mit Lösung).
   Entfällt gegenüber dem NAS: Heimkino-Steuerung, WLAN-QR, Foto-Umweg über den NAS (Anzeige lädt Fotos direkt). */
'use strict';

const COT = (() => {
  const VERSION = '0.2.0';

  // ── aus Chartster / NAS-Version ──
  const COLORS = ['#53f6ff', '#ff4fd8', '#8f5fff', '#4dff91', '#ffd84d', '#ff6b35'];
  const MAX_PLAYERS = 6;
  const DECADES = ['70er', '80er', '90er', '00er', '10er', '20er'];
  const EDITIONS = ['RS-500', 'Bond-Edition', 'WM-Edition', 'Popcorn-Edition', 'XMas-Edition'];
  const TARGETS = [7, 10, 15];
  const OFFLINE_AFTER = 8;                       // Sekunden ohne Lebenszeichen → Spieler gilt als weg

  const CATS = ['jahr', 'jahrgenau', 'interpret', 'titel', 'paparazzi'];   // Fünferpack: jede Kategorie einmal je Block
  const SONG_CATS = ['jahr', 'jahrgenau', 'interpret', 'titel'];           // Ersatz, wenn Paparazzi nicht geht
  const STAND_EVERY = 3;                         // Zwischenstand auf der Anzeige alle 3 Runden …
  const STAND_AFTER = 6;                         // … 6 s nach der Auflösung
  const CAT_TEXT = { jahr: 'Welches Jahr?', jahrgenau: 'Welches Jahr – ganz genau?', interpret: 'Wer singt das?',
                     titel: 'Wie heißt der Song?', paparazzi: 'Wer ist das?' };
  const AFTER_FIRST = 15;                        // kein Zeitlimit bis zur ersten Antwort – danach bleiben allen 15 s
  const N_OPTIONS = 5;
  const YEAR_LEVELS = { schwer: [1, 4], mittel: [2, 8], leicht: [3, 15] };   // Abstand der falschen Jahre
  const PAP_MODES = ['blur', 'tiles', 'mosaic'];
  const PAP_REVEAL = 30;                         // nach 30 s ist das Foto ganz zu sehen
  const MUSIC_WAIT = 20;                         // Zeit startet erst, wenn die Musik läuft – spätestens nach 20 s trotzdem

  const now = () => Date.now() / 1000;
  const choice = a => a[Math.floor(Math.random() * a.length)];
  function sample(a, n){                          // wie random.sample
    const c = a.slice();
    for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    return c.slice(0, n);
  }
  const shuffle = a => { const c = sample(a, a.length); a.splice(0, a.length, ...c); return a; };
  const uniq = a => [...new Set(a)];

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
        LANG_CACHE.ref = null;
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

  // =================================================================== Fragen bauen (wie cot_app.py)
  /* Zum Vergleichen: klein, ohne Akzente/Sonderzeichen */
  function fold(t){
    return String(t || '').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  /* Titel ohne Zusätze wie (Remastered 2011), [Official Video], - Radio Edit, feat. … */
  function clean(t){
    t = String(t || '').replace(/\s*[(\[].*?[)\]]/g, '');
    t = t.replace(/\s+-\s+.*$/, '');
    t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
    return t.trim();
  }
  /* Alle Künstler einer Angabe (Anton feat. DJ Ötzi → anton, dj otzi) */
  function arts(a){
    const parts = String(a || '').split(/\s+(?:feat\.?|ft\.?|featuring|x|vs\.?|und|and|&)\s+|,\s*|\s*&\s*/i);
    return new Set(parts.map(fold).filter(Boolean));
  }
  const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

  function yearOptions(y, loY, hiY){
    const level = choice(Object.keys(YEAR_LEVELS));
    let [lo, hi] = YEAR_LEVELS[level];
    const thisYear = new Date().getFullYear();
    hiY = Math.min(hiY, thisYear);
    let cands;
    while (true) {
      cands = [];
      for (let d = -hi; d <= hi; d++) if (Math.abs(d) >= lo && Math.abs(d) <= hi && y + d >= loY && y + d <= hiY) cands.push(y + d);
      if (cands.length >= N_OPTIONS - 1 || hi > 40) break;
      hi += 3;                                                 // Rand der Auswahl (z. B. nur 20er): weiter streuen
    }
    if (cands.length < N_OPTIONS - 1) {                        // notfalls auch außerhalb der Auswahl
      cands = [];
      for (let d = -15; d <= 15; d++) if (d && y + d <= thisYear) cands.push(y + d);
    }
    const opts = sample(cands, N_OPTIONS - 1).concat([y]).sort((a, b) => a - b);
    return [opts, level];
  }

  // ── Sprache: deutsch oder englisch? (Faustregel – Umlaute/ß oder typische Wörter, sonst wie die übrigen Titel des Künstlers)
  const DE_WORDS = new Set(`und ich nicht ein eine einen einem mein meine dein deine ist sind wir ihr mit auf fur von zu im dem des sie
er wie wenn nur noch auch kein keine alles bist hab habe haben wird mir dir dich mich uns nach uber immer heute nacht liebe
herz zeit welt leben schon allein wieder sommer madchen traum nie jetzt hier dann bis ohne geht komm tanz tanzen lied
stadt sonne himmel mond regen weg frei mann frau kinder deutsch das der durch zwei drei augen tage jahre bleib
gib sag lass lasst mach steh wo warum wer gluck einmal niemals alle viel viele kleine kleiner grosse grosser`.split(/\s+/));
  const EN_WORDS = new Set(`the you your my me love baby don t it s is of and to on we i m all be are what when this that with
for just can can t no oh yeah girl boy night tonight heart one get got go dance like know never time day away life back
come down up out let need want feel stay tell everybody forever dream world woman party song again together crazy beautiful
little wild fire light rain run home way star stop take make give keep look without only yourself myself dancing lonely true
real sweet gonna wanna`.split(/\s+/));
  const STOP = new Set([...DE_WORDS, ...EN_WORDS]);

  function lang(title){
    const t = title || '';
    if (/[äöüÄÖÜß]/.test(t)) return 'de';
    const w = fold(t).split(' ').filter(Boolean);
    let de = w.filter(x => DE_WORDS.has(x)).length, en = w.filter(x => EN_WORDS.has(x)).length;
    if (de > en) return 'de';
    if (en > de) return 'en';
    // keine typischen Wörter: Buchstabenmuster (Lieblingsmensch, Feuerwerk, Leiser ↔ Easy, Happy, Uptown Funk)
    de = 0; en = 0;
    for (const x of w) {
      if (x.length < 3 || /^\d+$/.test(x)) continue;
      de += /sch|eu|ei|tz|(ung|heit|keit|lich|chen|werk|nen|ern)$|^(ge|be|ver|zer)[a-z]{5,}/.test(x) ? 1 : 0;
      en += /th|wh|ou|ea|oo|ay|ck|(y|ing|ly|ness)$/.test(x) ? 1 : 0;
    }
    if (de > en) return 'de';
    if (en > de) return 'en';
    return null;                                               // unklar (z. B. „Hello“) → über den Künstler
  }
  const LANG_CACHE = { ref: null, art: new Map(), song: new Map() };
  function artistLang(a, songs){
    if (LANG_CACHE.ref !== songs) {
      const cnt = new Map();
      for (const s of songs) {
        const l = lang(clean(s.t || ''));
        if (l) {
          const k = fold(s.a || '');
          if (!cnt.has(k)) cnt.set(k, [0, 0]);
          cnt.get(k)[l === 'de' ? 0 : 1]++;
        }
      }
      LANG_CACHE.ref = songs; LANG_CACHE.song = new Map(); LANG_CACHE.art = new Map();
      for (const [k, v] of cnt) LANG_CACHE.art.set(k, v[0] > v[1] ? 'de' : v[1] > v[0] ? 'en' : null);
    }
    const r = LANG_CACHE.art.get(fold(a));
    return r === undefined ? null : r;
  }
  function songLang(s, songs){
    artistLang('', songs);                                     // Zwischenspeicher passend zur Songliste
    if (LANG_CACHE.song.has(s)) return LANG_CACHE.song.get(s);
    const r = lang(clean(s.t || '')) || artistLang(s.a || '', songs);
    LANG_CACHE.song.set(s, r);
    return r;
  }

  /* Wie ähnlich zwei Titel sind – gleiche Anfangswörter, gemeinsame Wörter, ähnliche Länge */
  function similar(a, b){
    const wa = fold(a).split(' ').filter(Boolean), wb = fold(b).split(' ').filter(Boolean);
    if (!wa.length || !wb.length) return 0;
    let sc = 0;
    if (wa[0] === wb[0]) sc += 3;
    const la = new Set(wa.filter(x => x.length > 2)), lb = new Set(wb.filter(x => x.length > 2));
    sc += 2 * [...la].filter(x => lb.has(x)).length;
    const sa = new Set(wa.filter(x => STOP.has(x))), sb = new Set(wb.filter(x => STOP.has(x)));
    sc += 1.5 * [...sa].filter(x => sb.has(x)).length / 2;
    if (Math.abs(wa.length - wb.length) <= 1) sc += 1;
    if (Math.abs(a.length - b.length) <= Math.max(4, a.length * 0.3)) sc += 1;
    return sc;
  }

  /* Kandidaten aus derselben Zeit (± Jahre) und – wenn möglich – derselben Sprache, ohne Überschneidung mit dem Künstler.
     key(s) liefert [Anzeige, Vergleichswert] oder null. */
  function eraPool(song, songs, key, { langMatch = true, eras = [5, 10, 99], need = N_OPTIONS - 1 } = {}){
    const mine = arts(song.a), y = +song.y, l = songLang(song, songs);   // wie NAS: Sprache aus der übergebenen Liste
    const levels = langMatch && l ? [2, 1, 0] : [0];
    for (const strict of levels) {
      for (const era of eras) {
        const seen = new Set(), pool = [];
        for (const s of songs) {
          if (Math.abs((+s.y || 0) - y) > era || overlap(arts(s.a || ''), mine)) continue;
          const k = key(s);
          if (!k || seen.has(k[1])) continue;
          const sl = strict ? songLang(s, songs) : null;
          if ((strict === 2 && sl !== l) || (strict === 1 && sl !== l && sl !== null)) continue;
          seen.add(k[1]);
          pool.push(k[0]);
        }
        if (pool.length >= need) return pool;
      }
    }
    return [];
  }
  /* Editionssong (X-Mas, Bond …): falsche Antworten zuerst aus derselben Edition */
  function sameEditionFirst(song, songs, key, need = N_OPTIONS - 1, eras = [5, 10, 99]){
    if (EDITIONS.includes(song.f)) {
      const same = songs.filter(s => s.f === song.f);
      const pool = eraPool(song, same, key, { eras: [99], need });
      if (pool.length >= need) return pool;
    }
    return eraPool(song, songs, key, { eras, need });
  }
  function simOnly(song, key){
    const sim = SIM.of(song.a);
    if (!sim.size) return null;
    return s => sim.has(fold(mainArtist(s.a || ''))) ? key(s) : null;
  }
  /* Kandidaten nur von ähnlichen Künstlern (±10 Jahre) */
  function simPool(song, songs, key){
    const sk = simOnly(song, key);
    if (!sk) return [];
    const p = sameEditionFirst(song, songs, sk, N_OPTIONS - 1, [10]);
    return p.length ? p : sameEditionFirst(song, songs, sk, 1, [10]);
  }

  function artistOptions(song, songs){
    const right = fold(song.a);
    const key = s => (s.a && fold(s.a) !== right) ? [s.a, fold(s.a)] : null;
    const pool = sameEditionFirst(song, songs, key);
    if (pool.length < N_OPTIONS - 1) return null;
    const sims = simPool(song, songs, key);                    // ähnliche Künstler zuerst
    const used = new Set([fold(mainArtist(song.a))]), picks = [];
    for (const group of [sample(sims, sims.length), sample(pool, pool.length)]) {
      for (const a of group) {                                 // jeder Hauptkünstler nur einmal
        const f = fold(mainArtist(a));
        if (picks.length < N_OPTIONS - 1 && !used.has(f)) { used.add(f); picks.push(a); }
      }
    }
    if (picks.length < N_OPTIONS - 1) return null;
    return shuffle(picks.concat([song.a]));
  }
  function titleOptions(song, songs){
    const right = clean(song.t) || song.t, rf = fold(right);
    const key = s => { const t = clean(s.t || ''), f = fold(t); return (t && t.length <= 40 && f !== rf) ? [t, f] : null; };
    let pool = sameEditionFirst(song, songs, key);
    if (pool.length < N_OPTIONS - 1) return null;
    const simt = new Set(simPool(song, songs, key));           // Titel ähnlicher Künstler bekommen einen Vorsprung
    pool = uniq(pool.concat([...simt].sort()));
    const score = new Map(pool.map(t => [t, similar(right, t) + (simt.has(t) ? 1.2 : 0) + Math.random() * 1.5]));
    const ranked = pool.slice().sort((a, b) => score.get(b) - score.get(a));
    const top = ranked.slice(0, Math.max(8, N_OPTIONS - 1));   // aus den ähnlichsten zufällig 4 – sonst immer dieselben
    return shuffle(sample(top, N_OPTIONS - 1).concat([right]));
  }

  // ── Paparazzi
  function mainArtist(a){
    return String(a || '').split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?|presents|pres\.|präsentiert)\s+/i)[0].replace(/^[ ,]+|[ ,]+$/g, '');
  }
  /* Künstler mit bester Platzierung ≤ 20 und Foto – aus der aktuellen Auswahl. → Map fold → {a, best, y, ca, song} */
  function paparazziArtists(pool){
    const out = new Map();
    for (const s of pool) {
      const p = s.p;
      if (!p || p > 20 || !s.a) continue;
      const name = mainArtist(s.a), k = fold(name);
      if (!k) continue;
      const cur = out.get(k);
      if (!cur || p < cur.best) out.set(k, { a: name, best: p, y: +s.y || 0, ca: s.ca || (cur || {}).ca, song: s });
      else if (!cur.ca && s.ca) cur.ca = s.ca;
    }
    for (const [k, v] of out) if (!v.ca || !v.y) out.delete(k);
    return out;
  }
  function paparazziOptions(art, arts_, songs){
    const mine = arts(art.a), l = artistLang(art.a, songs);
    for (const strict of (l ? [true, false] : [false])) {
      for (const era of [5, 10, 99]) {
        const pool = [];
        for (const [k, v] of arts_) {
          if (k !== fold(art.a) && Math.abs(v.y - art.y) <= era && !overlap(arts(v.a), mine) && (!strict || artistLang(v.a, songs) === l)) pool.push(v.a);
        }
        if (pool.length >= N_OPTIONS - 1) {
          const sim = SIM.of(art.a);                           // ähnliche Top-20-Künstler zuerst
          const near = pool.filter(a => sim.has(fold(mainArtist(a))));
          const picks = sample(near, Math.min(N_OPTIONS - 1, near.length));
          const rest = pool.filter(a => !picks.includes(a));
          return shuffle(picks.concat(sample(rest, N_OPTIONS - 1 - picks.length), [art.a]));
        }
      }
    }
    return null;
  }

  // ── Ähnliche Künstler: Datei aehnlich.json vom NAS (Plex + Last.fm), liegt neben dieser Datei
  const SIM = {
    related: new Map(),
    async load(url){
      try {
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) return;
        const cache = await r.json(), rel = new Map();
        const add = (a, b) => { if (!rel.has(a)) rel.set(a, new Set()); rel.get(a).add(b); };
        for (const k in cache) {
          const v = cache[k] || {};
          for (const name of (v.sim || []).concat(v.lfm || [])) {
            const f = fold(name);
            if (f && f !== k) { add(k, f); add(f, k); }       // gilt auch umgekehrt
          }
        }
        this.related = rel;
      } catch (e) {}
    },
    of(artist){ return this.related.get(fold(mainArtist(artist))) || new Set(); }
  };

  // ── Fotos: das Gastgeber-Gerät lädt Paparazzi-Fotos vorab (nur Künstler, deren Foto sicher lädt)
  const PHOTOS = {
    ok: new Set(), fail: new Set(), queue: [], busy: 0,
    ready(url){ return this.ok.has(url); },
    warm(urls){
      for (const u of urls) if (u && !this.ok.has(u) && !this.fail.has(u) && !this.queue.includes(u)) this.queue.push(u);
      this._next();
    },
    _next(){
      while (this.busy < 2 && this.queue.length) {
        const u = this.queue.shift(), img = new Image();
        this.busy++;
        const done = ok => { this.busy--; (ok ? this.ok : this.fail).add(u); this._next(); };
        img.onload = () => done(true); img.onerror = () => done(false);
        img.src = u;
      }
    }
  };
  const PHOTO_WARM = 40;                         // so viele Künstlerfotos der Auswahl vorab laden (mobile Daten schonen)

  // =================================================================== Spiel
  class Game {
    /* io: { save(stateJson), log(text), urls: { game, tv }, room, hostPid() } */
    constructor(io){
      this.io = io;
      this.phase = 'lobby';                                    // lobby → question → reveal → … → won
      this.players = [];                                       // {pid, name, color, score, admin}
      this.seen = {};                                          // pid → letztes Lebenszeichen (Sekunden)
      this.settings = { excluded: ['70er', '80er', ...EDITIONS], top: null, target: 10 };   // 90er bis heute, Ziel 10
      this.rev = 0;
      this.deck = [];                                          // gemischte Songs der Auswahl (keine Wiederholung im Spiel)
      this.catCycle = [];
      this.prepared = null;                                    // nächste Frage – schon fertig, damit die Musik sofort startet
      this.q = null;                                           // aktuelle Frage
      this.round = 0;
      this.result = null;                                      // Auflösung der letzten Frage
      this.winners = [];
      this.wonAt = 0;
      this.papUsed = new Set();                                // Paparazzi-Künstler, die in diesem Spiel schon dran waren
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
        this.wonAt = d.wonAt || 0;
        this.catCycle = d.catCycle || [];
        this.prepared = d.prepared || null;
        this.papUsed = new Set(d.papUsed || []);
        this.result = d.result || null;
        this.q = d.q ? Object.assign({}, d.q, { answered: new Set(d.q.answered || []) }) : null;
        if ((this.phase === 'question' || this.phase === 'reveal') && !this.q) this.phase = 'lobby';
        this.io.log(`[Spiel] Zustand geladen: ${this.players.length} Spieler, ${this.phase}`);
      } catch (e) { this.io.log('[Spiel] Zustand nicht lesbar: ' + e.message); }
    }
    dump(){
      const q = this.q ? Object.assign({}, this.q, { answered: [...this.q.answered] }) : null;
      return JSON.stringify({ players: this.players, settings: this.settings, phase: this.phase, round: this.round,
                              winners: this.winners, wonAt: this.wonAt, catCycle: this.catCycle, prepared: this.prepared,
                              papUsed: [...this.papUsed], result: this.result, q });
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
      const old = p.pid;
      p.pid = nw;
      delete this.seen[old];
      if (this.q) {
        if (old in this.q.answers) { this.q.answers[nw] = this.q.answers[old]; delete this.q.answers[old]; }
        if (this.q.answered.has(old)) { this.q.answered.delete(old); this.q.answered.add(nw); }
        if (this.q.buzz === old) this.q.buzz = nw;
      }
      if (this.result && old in this.result.gains) { this.result.gains[nw] = this.result.gains[old]; delete this.result.gains[old]; }
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
        this.settings.excluded = uniq(ex);
      }
      if ('top' in d) this.settings.top = (d.top === 'top10' || d.top === 'top20') ? d.top : null;
      if ('target' in d) {
        if (!TARGETS.includes(+d.target)) throw new Error('Ziel muss 7, 10 oder 15 sein');
        this.settings.target = +d.target;
      }
      this.deck = []; this.prepared = null;                    // neue Auswahl → neu mischen
      this.warmPhotos();
      this._save();
      return {};
    }
    pool(){ return Songs.filtered(this.settings.excluded, this.settings.top); }
    /* Fotos der Top-20-Künstler in der Auswahl vorab laden – Paparazzi nimmt nur Künstler, deren Foto sicher lädt */
    warmPhotos(){
      if (!Songs.loaded) return;
      const arts_ = [...paparazziArtists(this.pool()).values()].filter(a => !PHOTOS.fail.has(a.ca));
      const ready = arts_.filter(a => PHOTOS.ready(a.ca)).length;
      PHOTOS.warm(sample(arts_.filter(a => !PHOTOS.ready(a.ca)), Math.max(0, PHOTO_WARM - ready)).map(a => a.ca));
    }

    // ---------------------------------------------------------- Fragen
    _nextCat(){
      if (!this.catCycle.length) this.catCycle = sample(CATS, CATS.length);
      return this.catCycle.shift();
    }
    _prepare(){
      const pool = this.pool();
      if (pool.length < N_OPTIONS) { this.prepared = null; return; }
      const years = pool.filter(s => s.y).map(s => +s.y);
      const loY = Math.min(...years), hiY = Math.max(...years);
      let cat = this._nextCat();
      if (cat === 'paparazzi') {
        if (this._preparePaparazzi(pool)) return;
        cat = this.catCycle.length ? this._nextCat() : choice(SONG_CATS);   // zu wenige Top-20-Künstler → andere Frage
        if (cat === 'paparazzi') cat = choice(SONG_CATS);
      }
      for (let i = 0; i < 30; i++) {
        if (!this.deck.length) this.deck = sample(pool, pool.length);
        const s = this.deck.pop();
        if (!s.a || !s.t) continue;
        let options, correct, level = '';
        if (cat === 'jahr') {
          if (!s.y) continue;                                  // ohne Jahr keine Jahresfrage
          const [opts, lv] = yearOptions(+s.y, loY, hiY);
          level = lv; options = opts.map(String); correct = opts.indexOf(+s.y);
        } else if (cat === 'jahrgenau') {                      // Schätzfrage: Jahreszahl tippen, keine Antwortknöpfe
          if (!s.y) continue;
          options = []; correct = +s.y;
        } else {
          if (!s.y) continue;
          const o = cat === 'interpret' ? artistOptions(s, Songs.songs) : titleOptions(s, Songs.songs);
          if (!o) continue;
          const right = cat === 'interpret' ? s.a : (clean(s.t) || s.t);
          options = o; correct = o.indexOf(right);
          if (cat === 'interpret') {                           // fürs Protokoll: wie viele falsche Antworten „ähnlich“ sind
            const sim = SIM.of(s.a), n = o.filter(x => x !== right && sim.has(fold(mainArtist(x)))).length;
            level = n ? `(${n} ähnlich)` : '';
          }
        }
        this.prepared = { cat, level, options, correct, song: { l: s.l, y: s.y || null, a: s.a, t: s.t, c: s.c || '', f: s.f || '' } };
        return;
      }
      this.prepared = null;
    }
    _preparePaparazzi(pool){
      const arts_ = paparazziArtists(pool);
      if (arts_.size < N_OPTIONS) return false;
      const ready = [...arts_.keys()].filter(k => PHOTOS.ready(arts_.get(k).ca));   // nur Künstler, deren Foto sicher lädt
      if (!ready.length) { this.io.log('[Foto] noch kein Künstlerfoto geladen – statt Paparazzi eine normale Frage'); this.warmPhotos(); return false; }
      let keys = ready.filter(k => !this.papUsed.has(k));
      if (!keys.length) keys = ready;
      for (const k of sample(keys, keys.length).slice(0, 20)) {
        const art = arts_.get(k), opts = paparazziOptions(art, arts_, Songs.songs);
        if (!opts) continue;
        this.papUsed.add(k);
        const best = art.song, music = art.best > 10;          // Top 11–20: mit Song, Top 10: nur das Foto
        this.prepared = { cat: 'paparazzi', level: `Top ${music ? '20 mit Song' : '10 ohne Song'} (Platz ${art.best})`,
                          options: opts, correct: opts.indexOf(art.a), photo: art.ca, mode: choice(PAP_MODES), music,
                          song: { l: music ? best.l : null, y: best.y || null, a: art.a, t: best.t || '', c: best.c || '' } };
        this.warmPhotos();
        return true;
      }
      return false;
    }
    _activate(){
      if (!this.prepared) this._prepare();
      if (!this.prepared) throw new Error('Zu wenige Songs – Auswahl anpassen');
      const t = now(), music = !!this.prepared.song.l;         // Paparazzi Top 10: kein Song → Zeit läuft sofort
      this.q = Object.assign({}, this.prepared, { started: t, first: null, answers: {}, answered: new Set(), paused: null,
                                                  buzz: null, waiting: music ? t : null });
      this.prepared = null;
      this.round++;
      this.result = null;
      this.phase = 'question';
      this.io.log(`[Runde ${this.round}] ${CAT_TEXT[this.q.cat]} ${this.q.level} – ${this.q.song.a} – ${this.q.song.t}`);
      this._save();
      return {};
    }
    start(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin kann starten');
      if (this.phase !== 'lobby') throw new Error('Spiel läuft schon');
      if (this.players.length < 2) throw new Error('Mindestens 2 Spieler');
      if (this.pool().length < 10) throw new Error('Zu wenige Songs – Auswahl anpassen');
      this.players.forEach(p => { p.score = 0; });
      this.round = 0; this.winners = []; this.papUsed = new Set();
      // Fünferpack neu beginnen – die schon vorbereitete Frage zählt als erste des Blocks
      this.catCycle = sample(CATS, CATS.length).filter(c => !this.prepared || c !== this.prepared.cat);
      if (!this.deck.length) this.deck = sample(this.pool(), this.pool().length);
      this.io.log(`[Spiel] Start: ${this.players.length} Spieler, Ziel ${this.settings.target}, ${this.pool().length} Songs`);
      return this._activate();
    }
    nextSong(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      if (this.phase !== 'reveal') throw new Error('Gerade nicht möglich');
      if (this.winners.length) return this._finish();
      return this._activate();
    }
    _finish(){
      const best = Math.max(0, ...this.players.map(p => p.score));
      this.winners = best > 0 ? this.players.filter(p => p.score === best).map(p => p.name) : [];
      this.phase = 'won'; this.wonAt = now();
      this.io.log(`[Spiel] Sieg: ${this.winners.join(', ')} mit ${best} Punkten`);
      this._save();
      return {};
    }
    answer(pid, rnd, ch){
      if (this.phase !== 'question' || !this.q || rnd !== this.round) throw new Error('Zu spät – die Runde ist vorbei');
      if (!this.player(pid)) throw new Error('Bitte erst anmelden');
      if (this.q.cat === 'jahrgenau') {
        if (!(ch >= 1900 && ch <= 2099)) throw new Error('Bitte ein Jahr von 1900 bis 2099');
      } else if (!(ch >= 0 && ch < this.q.options.length)) throw new Error('Ungültige Antwort');
      if (this.q.paused) throw new Error("Pause – gleich geht's weiter");
      if (this.q.cat === 'paparazzi') {                        // wer zuerst tippt, entscheidet – sofort auflösen
        if (this.q.buzz) { const b = this.player(this.q.buzz); throw new Error(`Zu spät – ${b ? b.name : 'jemand'} war schneller`); }
        this.q.buzz = pid;
        this.q.answers[pid] = ch;
        this.q.answered.add(pid);
        this.rev++;
        this._reveal();
        return {};
      }
      this.q.answers[pid] = ch;                                // änderbar bis zur Auflösung – es zählt die letzte
      this.q.answered.add(pid);
      if (this.q.first === null && !this.q.waiting) this.q.first = now();   // erste Antwort startet die 15 s
      this.rev++;
      this._checkDone();
      return {};
    }
    _go(why){
      const q = this.q;
      if (!q || !q.waiting) return;
      const t = now();
      q.waiting = null; q.started = t;
      if (q.answered.size && q.cat !== 'paparazzi') q.first = t;   // wer schon getippt hat: 15 s ab Musikstart
      this.io.log(`[Runde ${this.round}] Zeit läuft (${why})`);
      this._save();
    }
    playing(pid, rnd, why){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      if (this.phase === 'question' && this.q && rnd === this.round) this._go(why);
      return {};
    }
    _deadline(){
      const q = this.q;
      if (q.waiting) return Infinity;                          // Uhr steht, bis die Musik läuft
      return q.first !== null ? q.first + AFTER_FIRST : Infinity;   // ohne Antwort kein Zeitlimit
    }
    _left(){
      if (this.q.waiting || this.q.first === null) return AFTER_FIRST;
      const t = this.q.paused || now();                        // in der Pause steht die Uhr
      return Math.max(0, this._deadline() - t);
    }
    _checkDone(){
      if (this.phase !== 'question' || this.q.paused) return;
      const active = this.players.map(p => p.pid).filter(pid => this.online(pid) || this.q.answered.has(pid));
      if ((active.length && active.every(pid => this.q.answered.has(pid))) || now() >= this._deadline()) this._reveal();
    }
    revealNow(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      if (this.phase !== 'question') throw new Error('Gerade nicht möglich');
      this._reveal();
      return {};
    }
    _reveal(){
      const q = this.q, gains = {};
      let winners, gain, right;
      if (q.cat === 'paparazzi') {
        // richtig → +1 für den Tipper; falsch → +1 für jeden anderen Spieler; niemand getippt → keine Punkte
        const b = q.buzz;
        right = b && q.answers[b] === q.correct ? [b] : [];
        winners = right.length ? right : (b ? this.players.filter(p => p.pid !== b).map(p => p.pid) : []);
        gain = 1;
      } else if (q.cat === 'jahrgenau') {
        // genau richtig → +2 (alle, die es genau haben); sonst die Nächsten → +1 (bei Gleichstand alle Nächsten)
        const diffs = {};
        for (const pid in q.answers) if (this.player(pid)) diffs[pid] = Math.abs(q.answers[pid] - q.correct);
        right = Object.keys(diffs).filter(pid => diffs[pid] === 0);
        if (right.length) { winners = right; gain = 2; }
        else if (Object.keys(diffs).length) {
          const m = Math.min(...Object.values(diffs));
          winners = Object.keys(diffs).filter(pid => diffs[pid] === m); gain = 1;
        } else { winners = []; gain = 1; }
      } else {
        right = Object.keys(q.answers).filter(pid => q.answers[pid] === q.correct && this.player(pid));
        winners = right;
        gain = right.length === 1 && this.players.length >= 2 ? 2 : 1;
      }
      for (const pid of winners) { const p = this.player(pid); if (p) { p.score += gain; gains[pid] = gain; } }
      const counts = q.options.map(() => 0), guesses = [];
      if (q.cat === 'jahrgenau') {
        for (const pid in q.answers) {
          const pl = this.player(pid);
          if (pl) guesses.push({ name: pl.name, color: pl.color, year: q.answers[pid], diff: q.answers[pid] - q.correct, gain: gains[pid] || 0 });
        }
        guesses.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } else {
        for (const pid in q.answers) counts[q.answers[pid]]++;
      }
      this.result = { gains, counts, guesses, at: now(),
                      alone: q.cat !== 'paparazzi' && q.cat !== 'jahrgenau' && gain === 2 && right.length > 0,
                      buzzRight: q.cat === 'paparazzi' ? right.length > 0 : null };
      this.phase = 'reveal';
      const best = Math.max(0, ...this.players.map(p => p.score));
      this.winners = best >= this.settings.target ? this.players.filter(p => p.score === best).map(p => p.name) : [];
      this.io.log(`[Runde ${this.round}] Auflösung: ` + (q.cat === 'paparazzi'
        ? 'Paparazzi: ' + (q.buzz ? (right.length ? 'richtig' : 'falsch') + ' getippt' : 'niemand getippt')
        : q.cat === 'jahrgenau' ? `Jahr genau: ${right.length} genau, +${gain} für ${winners.length}` : `${right.length} richtig`)
        + (this.result.alone ? ' – allein richtig +2' : '') + (this.winners.length ? ` – Ziel erreicht: ${this.winners.join(', ')}` : ''));
      this._save();
      if (!this.winners.length && !this.prepared) this._prepare();   // nächsten Song schon bereitlegen
    }
    _adminQ(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      if (this.phase !== 'question' || !this.q) throw new Error('Nur während eines Songs');
    }
    skip(pid){
      this._adminQ(pid);
      this.io.log(`[Runde ${this.round}] übersprungen: ${this.q.song.a} – ${this.q.song.t}`);
      this.round--;
      return this._activate();
    }
    pause(pid){
      this._adminQ(pid);
      if (this.q.paused) return {};
      this.q.paused = now();
      this.io.log(`[Runde ${this.round}] Pause`);
      this._save();
      return {};
    }
    resume(pid){
      this._adminQ(pid);
      if (!this.q.paused) return {};
      const d = now() - this.q.paused;
      this.q.started += d;                                     // Zeit läuft dort weiter, wo sie stand
      if (this.q.first !== null) this.q.first += d;
      if (this.q.waiting) this.q.waiting += d;
      this.q.paused = null;
      this.io.log(`[Runde ${this.round}] weiter`);
      this._save();
      return {};
    }
    adjust(pid, name, delta){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      const p = this.players.find(x => x.name === name);
      if (!p || (delta !== -1 && delta !== 1)) throw new Error('Spieler nicht gefunden');
      p.score = Math.max(0, p.score + delta);
      this.io.log(`[Spiel] Punkte korrigiert: ${name} ${delta > 0 ? '+' : ''}${delta} → ${p.score}`);
      this._save();
      return {};
    }
    remove(pid, name){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      const p = this.players.find(x => x.name === name);
      if (!p) throw new Error('Spieler nicht gefunden');
      if (p.pid === pid) throw new Error('Du kannst dich nicht selbst entfernen');
      this.players.splice(this.players.indexOf(p), 1);
      delete this.seen[p.pid];
      if (this.q) { delete this.q.answers[p.pid]; this.q.answered.delete(p.pid); }
      this.io.log(`[Spiel] ${name} entfernt`);
      this._save();
      if (this.phase === 'question') this._checkDone();
      return {};
    }
    endGame(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      if (this.phase !== 'question' && this.phase !== 'reveal') throw new Error('Es läuft kein Spiel');
      return this._finish();
    }
    toLobby(pid){
      if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
      this.phase = 'lobby'; this.q = null; this.result = null; this.prepared = null; this.winners = [];
      this.players.forEach(p => { p.score = 0; });
      this._save();
      return {};
    }
    /* alle 0,5 s (wie der Ticker des NAS) */
    tick(){
      if (this.phase === 'question') {
        const q = this.q;
        if (q.waiting && !q.paused && now() - q.waiting >= MUSIC_WAIT) this._go('nach 20 s ohne Musik');
        this._checkDone();
      }
    }

    // ---------------------------------------------------------- Anfragen der Geräte (wie die Flask-Routen)
    handle(path, body){
      body = body || {};
      const pid = String(body.pid || '');
      if (path === '/api/join') return this.join(pid, body.name, !!body.admin && pid === this.io.hostPid());
      if (path === '/api/answer') {
        const rnd = parseInt(body.round, 10), ch = parseInt(body.choice, 10);
        if (isNaN(rnd) || isNaN(ch)) throw new Error('Ungültige Antwort');
        return this.answer(pid, rnd, ch);
      }
      if (path === '/api/admin/settings') {
        if (!this.isAdmin(pid)) throw new Error('Nur der Admin');
        return this.setSettings(body);
      }
      if (path.startsWith('/api/admin/')) {
        const cmd = path.slice(11);
        if (cmd === 'adjust') return this.adjust(pid, String(body.name || ''), parseInt(body.delta, 10));
        if (cmd === 'remove') return this.remove(pid, String(body.name || ''));
        if (cmd === 'playing') return this.playing(pid, parseInt(body.round, 10), String(body.why || 'Gastgeber').slice(0, 40));
        const fn = { start: 'start', next: 'nextSong', reveal: 'revealNow', lobby: 'toLobby', skip: 'skip',
                     pause: 'pause', resume: 'resume', end: 'endGame' }[cmd];
        if (!fn) throw new Error('Unbekannter Befehl');
        return this[fn](pid);
      }
      throw new Error('Unbekannte Anfrage');
    }

    // ---------------------------------------------------------- Zustand für alle Geräte
    /* tv=true: Anzeige – bekommt Foto und Auflösung. Handys/Gastgeber: nur Antworten und das eigene Ergebnis. */
    view(pid, tv){
      const pool = this.pool(), admin = this.isAdmin(pid), q = this.q, res = this.result, t = now();
      const out = {
        v: VERSION, rev: this.rev, phase: this.phase, round: this.round,
        players: this.players.map(p => ({ id: pidId(p.pid), name: p.name, color: p.color, score: p.score, admin: !!p.admin,
                                          online: this.online(p.pid), me: p.pid === pid,
                                          answered: !!(q && this.phase === 'question' && q.answered.has(p.pid)),
                                          gain: (res && this.phase === 'reveal') ? (res.gains[p.pid] || 0) : 0 })),
        maxPlayers: MAX_PLAYERS,
        settings: this.settings,
        songs: { pool: pool.length, total: Songs.songs.length, found: Songs.loaded, loading: !Songs.loaded && !Songs.failed },
        gameUrl: this.io.urls.game, tvUrl: this.io.urls.tv, room: this.io.room, wifi: ''
      };
      if (q && (this.phase === 'question' || this.phase === 'reveal')) {
        const bp = q.buzz ? this.player(q.buzz) : null;
        out.q = { cat: q.cat, text: CAT_TEXT[q.cat], options: q.options, mine: q.answers[pid] ?? null, buzzer: bp ? bp.name : null };
        if (tv && q.cat === 'paparazzi') {
          const tt = q.paused || t;
          out.q.photo = q.photo; out.q.pmode = q.mode; out.q.reveal = PAP_REVEAL; out.q.music = q.music;
          out.q.elapsed = this.phase === 'question' ? (q.waiting ? 0 : Math.round((tt - q.started) * 10) / 10) : PAP_REVEAL;
        }
      }
      if (this.phase === 'question') {
        Object.assign(out.q, { left: Math.ceil(this._left()), mode: q.first !== null ? 'after' : 'wait',
                               total: AFTER_FIRST, paused: !!q.paused, waiting: !!q.waiting });
        if (admin) out.play = q.song.l;                        // nur der Gastgeber bekommt die Spotify-ID
      }
      if (this.phase === 'reveal' && res && tv) {              // Auflösung nur für die Anzeige
        const s = q.song;
        Object.assign(out.q, { correct: q.correct, counts: res.counts, guesses: res.guesses || [], alone: res.alone,
                               buzzRight: res.buzzRight, music: q.music !== false, song: { y: s.y, a: s.a, t: s.t, c: s.c } });
      }
      if (this.phase === 'reveal') {
        out.winners = this.winners;
        if (tv && res && this.round % STAND_EVERY === 0 && !this.winners.length) out.standNow = t - (res.at || 0) >= STAND_AFTER;
      }
      if (this.phase === 'won') {
        out.winners = this.winners;
        out.wonAgo = Math.min(60, Math.round((t - this.wonAt) * 10) / 10);   // Siegerehrung auf allen Geräten im gleichen Takt
      }
      // Gastgeber: nächsten Song schon kennen – Spotify muss im selben Tipp starten (Start, Nächster Song, Überspringen)
      if (admin && ['lobby', 'reveal', 'question'].includes(this.phase) && !this.winners.length) {
        if (!this.prepared && pool.length >= N_OPTIONS) this._prepare();
        out.next = this.prepared ? this.prepared.song.l : null;   // null = ohne Musik
        out.hasNext = !!this.prepared;
      }
      return out;
    }
    /* eigene Antworten der Spieler (für die Handys nach Neuladen) */
    answers(){
      if (!this.q || (this.phase !== 'question' && this.phase !== 'reveal')) return { round: this.round, a: {} };
      const a = {};
      for (const pid in this.q.answers) a[pidId(pid)] = this.q.answers[pid];
      return { round: this.round, a };
    }
  }

  return { VERSION, Game, Songs, SIM, PHOTOS, pidId, fold, mainArtist, lang, yearOptions, artistOptions, titleOptions,
           paparazziArtists, DECADES, EDITIONS, CAT_TEXT };
})();
