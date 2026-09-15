import { stripServedComments } from "./strip-served-comments";

// 36de4e90 item 17 -- read-aloud bar. W1, Day 227.
// Cloud's ruling (a76ff49d), superseding an earlier server-render plan: browser speechSynthesis
// only, same mechanism as the lab read-aloud bar (templates/living-page.html is the reference
// implementation) and this fleet's own silver-voicetest pause/resume prior art (repos/
// silver-voicetest, branch w1/read-aloud-pause-resume, Day 183). Ported rather than re-derived --
// coding-discipline's own rule: a second implementation of the same contract is how the two
// drift, and both of those were driven and bug-fixed the hard way (Chrome/Android pause flakiness,
// a generation-counter race on deliberate cancel).
//
// TWO VOICES, Darren's exact naming (bench, a76ff49d): Female picks "Google US English", Male
// picks "Google UK English Male". Elsewhere (Chrome-only names, so anywhere else) falls back to
// the first en-US female-ish voice / the first en-GB voice.
// ⛔ d31b6842, Darren via Cloud, SUPERSEDES the line above and the "Voice: <name>" label this file
// used to render: no voice-name text anywhere in the bar any more -- the active Female/Male
// button is the only indicator, and an elsewhere-fallback is now SILENT rather than disclosed.
//
// sayHost()/sayUrls() (the "speak 'link' plus the site name, never the raw URL" contract) are
// copied from templates/living-page.html for the SAME reason -- this covers any raw URL that
// ends up in plain collected text; the source links in validator-view.ts's fig() already carry
// data-rab-skip/data-rab-say precomputed server-side (the URL lives only in href there, which a
// text-scanning function can never see).

// Floating pill, not an inline strip (16713cea, Darren via Cloud, Day 227): fixed near the
// bottom of the viewport, centred, so it stays visible while scrolling and never claims the
// full page width. max-width caps it on narrow screens; the voice-name label is truncated
// (not forced to width:100%) so wrapping never turns the pill into a second full-width row.
//
// NARROW-WIDTH FIX (33f5a4a2, Cloud measured 400w): the wide layout (text buttons, two-button
// voice group, progress + voice-name labels) wrapped to three stacked rows at 400px and covered
// report text. Under 480px: play/pause go icon-only (text hidden via font-size:0, an icon drawn
// with ::before so no separate narrow-only markup is needed), the two voice buttons collapse
// into ONE toggle (#rabVoiceToggle, a distinct element rather than a CSS show/hide of one of the
// wide pair -- hiding-and-reusing one of two "select this gender" buttons as a "switch" button
// would need its click handler to mean two different things depending on viewport width), and
// progress/voice-name are dropped entirely to keep the pill under 56px tall at 400 wide.
// PRE-EXISTING BUG, found while driving this change (not introduced by it): SITE_CSS's global
// "button,.btn{display:inline-block;...}" is an AUTHOR-origin rule, and author rules beat
// user-agent rules regardless of selector specificity -- so it always wins over the browser's
// built-in "[hidden]{display:none}", and the Pause button (hidden by default, toggled via
// pauseBtn.hidden in JS) rendered visible the entire time. Scoped fix here rather than touching
// the shared global rule, which other pages may depend on for reasons out of this change's scope.
// SKIP BACK/FORWARD (501e22eb, Darren live via Cloud, amendment on item 17): jump to the
// previous/next section, a section starting at each heading inside #rab-doc. Icon-only at
// every width (no wide-vs-narrow text variant needed, unlike Play/Pause), hidden until playing
// starts (same [hidden] pattern as Pause -- shown for the whole playing state, paused included).
export const READALOUD_CSS = stripServedComments(`
.rab-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;max-width:calc(100vw - 24px);display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;background:var(--panel);border-radius:999px;padding:8px 12px;box-shadow:0 4px 0 0 var(--rule)}
.rab-bar button{font:700 14px/1 inherit;border:none;border-radius:999px;cursor:pointer;padding:9px 16px;box-shadow:none}
.rab-bar [hidden]{display:none !important}
.rab-play{color:#fff;background:var(--accent)}
.rab-play[data-playing="true"]{background:var(--accent2)}
.rab-pause{color:var(--ink);background:var(--rule)}
.rab-skip{color:var(--ink);background:#fff;border:1px solid var(--rule) !important;font-size:15px;padding:9px 12px}
.rab-speed{color:var(--accent);background:#fff;border:1px solid var(--rule) !important}
.rab-voice{display:flex;gap:4px}
.rab-voice button{color:var(--ink);background:#fff;border:1px solid var(--rule) !important;padding:9px 12px}
.rab-voice button[data-active="true"]{color:#fff;background:var(--accent2);border-color:transparent !important}
.rab-voice-toggle{display:none;color:#fff;background:var(--accent2);border:none !important}
.rab-progress{font-size:12.5px;color:var(--muted)}
[data-rab-highlight="1"]{outline:2px solid var(--accent2);outline-offset:3px;border-radius:6px}
@media(max-width:480px){
  .rab-bar{gap:6px;padding:7px 10px;bottom:14px;flex-wrap:nowrap}
  .rab-play,.rab-pause{font-size:0;padding:8px 10px;line-height:1}
  .rab-play::before{content:'\\25b6';font-size:15px}
  .rab-play[data-playing="true"]::before{content:'\\23f9'}
  .rab-pause::before{content:'\\23f8';font-size:15px}
  .rab-pause[data-paused="true"]::before{content:'\\25b6';font-size:15px}
  .rab-skip{padding:8px 9px;font-size:13px}
  .rab-speed{padding:8px 10px;font-size:12px}
  .rab-voice{display:none}
  .rab-voice-toggle{display:inline-block;padding:8px 12px;font-size:12.5px}
  .rab-progress{display:none}
}
`);

export function readaloudBarHtml(): string {
  return (
    `<div class="rab-bar">` +
    `<button type="button" class="rab-play" id="rabPlay" data-playing="false">Read aloud</button>` +
    `<button type="button" class="rab-skip" id="rabSkipBack" hidden aria-label="Previous section">&#9198;</button>` +
    `<button type="button" class="rab-skip" id="rabSkipFwd" hidden aria-label="Next section">&#9197;</button>` +
    `<button type="button" class="rab-pause" id="rabPause" hidden>Pause</button>` +
    `<button type="button" class="rab-speed" id="rabSpeed" data-rate="1">1&times;</button>` +
    `<div class="rab-voice" role="group" aria-label="Voice">` +
    `<button type="button" id="rabVoiceFemale" data-voice="female" data-active="true">Female</button>` +
    `<button type="button" id="rabVoiceMale" data-voice="male">Male</button>` +
    `</div>` +
    `<button type="button" class="rab-voice-toggle" id="rabVoiceToggle" aria-label="Switch voice">Female</button>` +
    `<span class="rab-progress" id="rabProgress"></span>` +
    `</div>`
  );
}

// ES5 on purpose, matching every other inline script in this repo -- these strings get embedded
// directly into a served HTML page, not run through a bundler.
export const READALOUD_SCRIPT = stripServedComments(`
<script>
(function(){
  var docEl = document.getElementById('rab-doc');
  var playBtn = document.getElementById('rabPlay');
  var pauseBtn = document.getElementById('rabPause');
  var skipBackBtn = document.getElementById('rabSkipBack');
  var skipFwdBtn = document.getElementById('rabSkipFwd');
  var speedBtn = document.getElementById('rabSpeed');
  var femaleBtn = document.getElementById('rabVoiceFemale');
  var maleBtn = document.getElementById('rabVoiceMale');
  var voiceToggleBtn = document.getElementById('rabVoiceToggle');
  var progressEl = document.getElementById('rabProgress');
  if (!docEl || !playBtn || !('speechSynthesis' in window)) { if (playBtn) playBtn.style.display = 'none'; return; }
  var synth = window.speechSynthesis;

  // Female -> "Google US English", Male -> "Google UK English Male". Elsewhere: first en-US
  // female-ish voice, or first en-GB voice -- silently (d31b6842 supersedes the earlier
  // "show the voice name" ruling; the active Female/Male button is the only indicator now).
  var voiceGender = 'female';
  function pickVoice(gender){
    var vs = synth.getVoices();
    if (!vs.length) return null;
    if (gender === 'female'){
      var exact = vs.filter(function(v){ return v.name === 'Google US English'; })[0];
      if (exact) return exact;
      var fem = vs.filter(function(v){
        return /en[-_]US/i.test(v.lang) && /female/i.test(v.name);
      })[0];
      if (fem) return fem;
      return vs.filter(function(v){ return /en[-_]US/i.test(v.lang); })[0] || vs[0];
    }
    var exactM = vs.filter(function(v){ return v.name === 'Google UK English Male'; })[0];
    if (exactM) return exactM;
    return vs.filter(function(v){ return /en[-_]GB/i.test(v.lang); })[0]
        || vs.filter(function(v){ return /^en/i.test(v.lang); })[0] || vs[0];
  }
  var localVoice = null;
  function pickLocalVoice(gender){
    var vs = synth.getVoices(); if (!vs.length) return null;
    var local = vs.filter(function(v){ return v.localService; });
    if (gender === 'female'){
      return local.filter(function(v){ return /en[-_]US/i.test(v.lang); })[0]
          || local.filter(function(v){ return /^en/i.test(v.lang); })[0] || local[0] || null;
    }
    return local.filter(function(v){ return /en[-_]GB/i.test(v.lang); })[0]
        || local.filter(function(v){ return /^en/i.test(v.lang); })[0] || local[0] || null;
  }
  var voice = null, fallback = false;
  function refreshVoice(){
    voice = pickVoice(voiceGender);
    localVoice = pickLocalVoice(voiceGender);
  }
  refreshVoice();
  synth.addEventListener('voiceschanged', refreshVoice);

  var RATES = [1, 1.25, 1.5];
  var ri = 0;
  speedBtn.addEventListener('click', function(){
    ri = (ri + 1) % RATES.length;
    speedBtn.textContent = (RATES[ri] % 1 === 0 ? RATES[ri] + '' : RATES[ri].toFixed(2)) + '\\u00d7';
    speedBtn.setAttribute('data-rate', RATES[ri]);
  });

  function setVoiceGender(g){
    if (voiceGender === g) return;
    voiceGender = g;
    femaleBtn.setAttribute('data-active', g === 'female' ? 'true' : 'false');
    maleBtn.setAttribute('data-active', g === 'male' ? 'true' : 'false');
    // Narrow-width toggle (33f5a4a2): a SEPARATE element from the wide female/male pair, kept in
    // sync here so a mid-session resize (or the initial narrow render) always shows the CURRENT
    // voice rather than a stale default -- its own click handler flips to the other gender
    // outright, which the wide pair's "select this gender" handlers deliberately do not.
    if (voiceToggleBtn){ voiceToggleBtn.textContent = g === 'female' ? 'Female' : 'Male'; voiceToggleBtn.setAttribute('data-voice', g); }
    refreshVoice();
    // Switching voice mid-playback restarts from the current chunk in the new voice, rather than
    // silently finishing the sentence in the old one -- the visible choice should take effect now.
    if (playing) { var atQi = qi; silentRestart(atQi); }
  }
  femaleBtn.addEventListener('click', function(){ setVoiceGender('female'); });
  maleBtn.addEventListener('click', function(){ setVoiceGender('male'); });
  if (voiceToggleBtn) voiceToggleBtn.addEventListener('click', function(){ setVoiceGender(voiceGender === 'female' ? 'male' : 'female'); });

  // Speak "link" plus the site name for a URL, never the raw address.
  function sayHost(h){
    var s = String(h).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\\/[\\/]/, '').replace(/^www\\./i, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    var parts = s.split('.');
    if (parts.length > 1) parts.pop();
    return parts.join(' ').replace(/-/g, ' ').trim();
  }
  // f17e1ccb, Cloud: a BARE domain (no scheme, no www.) still names a real site in prose --
  // "sharpsheets.io / franchisegator.com" in a competitor writeup. Conservative TLD allowlist so
  // this never fires on an abbreviation (e.g., i.e.) or a decimal number; a match immediately
  // followed by another ".letter" is left alone (multi-level domains are rare in this app's
  // prose and the scheme/www. pattern above already covers the common real case).
  var BARE_DOMAIN = /\\b[a-z0-9][a-z0-9-]*\\.(?:com|io|org|net|co|ai|dev|app|de|uk|us|shop|store)\\b(?!\\.[a-z])/gi;
  function sayUrls(text){
    return String(text)
      .replace(/\\b(?:https?:\\/\\/|www\\.)[^\\s<>"']+[^\\s<>"'.,;:!?)]/gi,
               function(m){ return ' link, ' + sayHost(m) + ' '; })
      .replace(BARE_DOMAIN, function(m){ return ' link, ' + sayHost(m) + ' '; })
      .replace(/\\s+([,.;:!?])/g, '$1')
      .replace(/\\s+/g, ' ');
  }
  function sayWord(el){
    if (!el || el.nodeType !== 1 || !el.hasAttribute('data-rab-say')) return '';
    return String(el.getAttribute('data-rab-say') || '').trim();
  }
  // 335c17db, P1 live bug (Darren via Cloud): the bar read only headings, never body text, on
  // pages whose real content sits in <label> (form field captions) -- LABEL was never in SEL, so
  // a page like /dashboard/marketing-plan, almost entirely labels + textareas, spoke nothing but
  // its handful of <h3>/<p> headings and muted hints. Measured, not guessed: captured the actual
  // queued utterance list on the validator report (35 entries, every body paragraph and
  // competitor figure present -- that page was already correct, being pure p/li/td) versus
  // marketing-plan (13 entries, every one a heading or hint, zero of the five field labels).
  // ⛔ d3d5b56d SUPERSEDES the first pass's "skip form controls" for VALUES: on a document page
  // the field VALUE is the body -- it is what the user typed. Now: label then its current value
  // ("Elevator pitch. My idea is..."), skipping an empty value entirely (an unfilled field reads
  // as just its label, same as before). Buttons and a <select>'s full OPTION LIST are still
  // never read -- only the label text and the control's OWN current value/selection.
  function labelValueText(ctrl){
    if (!ctrl) return '';
    if (ctrl.tagName === 'SELECT'){
      var opt = ctrl.options[ctrl.selectedIndex];
      return opt ? (opt.textContent || '').trim() : '';
    }
    return (ctrl.value || '').trim();
  }
  function speakText(root){
    if (root.nodeType === 1 && root.hasAttribute('data-rab-skip'))
      return sayWord(root) ? (' ' + sayWord(root) + ' ') : '';
    // A bare <textarea> NOT wrapped in a <label> (elevator_pitch, target_keywords,
    // bid_keywords -- this repo mixes both markup shapes) reads its own value directly, as its
    // own block right after the preceding heading in document order. Never reached for a
    // label-wrapped textarea: collect() below excludes those, since the label already reads it.
    if (root.tagName === 'TEXTAREA') return sayUrls(root.value || '');
    var out = [];
    (function walk(node){
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++){
        var c = kids[i];
        if (c.nodeType === 3){ out.push(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        if (c.hasAttribute('data-rab-skip')){
          if (sayWord(c)) out.push(' ' + sayWord(c) + ' ');
          continue;
        }
        // Buttons and the bar's own controls are never walked into. SELECT/INPUT/TEXTAREA are
        // skipped HERE (their raw markup, e.g. every OPTION's text) but their current value is
        // appended separately below when root is the enclosing LABEL -- so a label's value is
        // read exactly once, never zero times (silently dropped) and never twice (both walked
        // AND appended).
        var tn = c.tagName;
        if (tn === 'SELECT' || tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'BUTTON') continue;
        walk(c);
      }
    })(root);
    var text = sayUrls(out.join(''));
    if (root.tagName === 'LABEL'){
      var value = labelValueText(root.querySelector('input, textarea, select'));
      if (value) text = (text.trim() ? text.trim() + '. ' : '') + sayUrls(value);
    }
    return text;
  }

  var SEL = 'h1, h2, h3, p, li, td, blockquote, label, textarea, [data-rab-say]';
  var blocks = [];
  function collect(){
    blocks = Array.prototype.slice.call(docEl.querySelectorAll(SEL)).filter(function(el){
      var sk = el.closest('[data-rab-skip]');
      if (sk && !(sk === el && sayWord(el))) return false;
      // A label-wrapped textarea is read once, by its enclosing LABEL (speakText appends the
      // value there) -- without this exclusion it would ALSO match here as its own block and
      // read the same value a second time.
      if (el.tagName === 'TEXTAREA' && el.closest('label')) return false;
      var text = el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
      return text.trim().length > 1;
    });
  }

  // f17e1ccb, Cloud: the old regex split on EVERY '.', '!' or '?', so "sharpsheets.io /
  // franchisegator.com)" became three garbled chunks ("io / franchisegator.", "com), bundles...").
  // Now: split only where a terminator is followed by whitespace + a capital letter, or by the
  // end of the string -- never inside a bare token like a domain name.
  var SENTENCE_END = /[.!?]+(?=\\s+[A-Z]|\\s*$)/g;
  function splitSentences(text){
    var out = [], last = 0, m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(text))){
      var end = m.index + m[0].length;
      out.push(text.slice(last, end));
      last = end;
    }
    if (last < text.length) out.push(text.slice(last));
    return out.length ? out : [text];
  }
  function chunk(text){
    var sentences = splitSentences(text);
    var out = [];
    sentences.forEach(function(s){
      s = s.trim(); if (!s) return;
      while (s.length > 200){
        var cut = s.lastIndexOf(' ', 200); if (cut < 100) cut = 200;
        out.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
      }
      if (s) out.push(s);
    });
    return out;
  }

  // queue[i] = {text, blockIndex} -- blockIndex drives the highlight/position readout.
  var queue = [], qi = 0, playing = false, paused = false, resumer = null, gen = 0;
  // SKIP BACK/FORWARD (501e22eb): a "section" is the span of blocks from one heading (h1/h2/h3)
  // up to (not including) the next. currentSectionStart/sectionStartAt track the blockIndex and
  // wall-clock time the CURRENTLY PLAYING section began, so skip-back can tell "within 3s of the
  // section start" from "well into it" -- the Web Speech API exposes no per-utterance playback
  // position, so wall-clock elapsed since the section changed is the only signal available, same
  // as a typical media player's "tap-back" window.
  var currentSectionStart = -1, sectionStartAt = 0;
  function headingIndices(){
    var idx = [];
    for (var i = 0; i < blocks.length; i++){
      var tn = blocks[i].tagName;
      if (tn === 'H1' || tn === 'H2' || tn === 'H3') idx.push(i);
    }
    return idx;
  }
  function sectionStartBlockIndex(blockIndex){
    var heads = headingIndices(), start = 0;
    for (var i = 0; i < heads.length; i++){
      if (heads[i] <= blockIndex) start = heads[i]; else break;
    }
    return start;
  }
  function firstQueueIndexForBlock(blockIndex){
    for (var i = 0; i < queue.length; i++){ if (queue[i].blockIndex >= blockIndex) return i; }
    return queue.length ? queue.length - 1 : 0;
  }

  function clearHl(){
    var els = docEl.querySelectorAll('[data-rab-highlight]');
    for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-rab-highlight');
  }
  function highlightCurrent(){
    clearHl();
    if (qi >= queue.length) return;
    var el = blocks[queue[qi].blockIndex];
    if (el){ el.setAttribute('data-rab-highlight', '1'); try { el.scrollIntoView({block:'center', behavior:'smooth'}); } catch(e){} }
  }
  function updateProgress(){
    if (!progressEl) return;
    progressEl.textContent = queue.length ? (Math.min(qi + 1, queue.length) + ' / ' + queue.length) : '';
  }

  function setPlaying(p){
    playing = p;
    playBtn.setAttribute('data-playing', p ? 'true' : 'false');
    playBtn.textContent = p ? 'Stop' : 'Read aloud';
    pauseBtn.hidden = !p;
    if (skipBackBtn) skipBackBtn.hidden = !p;
    if (skipFwdBtn) skipFwdBtn.hidden = !p;
    if (!p) setPaused(false);
    if (!p) { clearHl(); if (progressEl) progressEl.textContent = ''; currentSectionStart = -1; }
    if (p && !paused && !resumer) resumer = setInterval(function(){ if (synth.speaking) synth.resume(); }, 8000);
    if (!p && resumer) { clearInterval(resumer); resumer = null; }
  }
  function setPaused(p){
    paused = p;
    pauseBtn.setAttribute('data-paused', p ? 'true' : 'false');
    pauseBtn.textContent = p ? 'Resume' : 'Pause';
    if (p && resumer) { clearInterval(resumer); resumer = null; }
    if (!p && playing && !resumer) resumer = setInterval(function(){ if (synth.speaking) synth.resume(); }, 8000);
  }
  function stop(){ gen++; playing = false; paused = false; queue = []; qi = 0; try { synth.cancel(); } catch(e){} setPlaying(false); }

  // Generation counter, not a synchronous flag: onend fires ASYNCHRONOUSLY after cancel(), so a
  // flag cleared on the next line is already back to false by the time the stale onend lands.
  function silentRestart(atQi){
    gen++;
    try { synth.cancel(); } catch(e){}
    qi = atQi;
    speakNext();
  }

  function speakNext(){
    if (!playing || paused) return;
    if (qi >= queue.length){ setPlaying(false); return; }
    var secStart = sectionStartBlockIndex(queue[qi].blockIndex);
    if (secStart !== currentSectionStart){ currentSectionStart = secStart; sectionStartAt = Date.now(); }
    var myGen = gen;
    var v = fallback ? localVoice : voice;
    var u = new SpeechSynthesisUtterance(queue[qi].text);
    if (v) { u.voice = v; u.lang = v.lang || (voiceGender === 'female' ? 'en-US' : 'en-GB'); }
    else { u.lang = voiceGender === 'female' ? 'en-US' : 'en-GB'; }
    var rate = Number(speedBtn.getAttribute('data-rate')) || 1;
    u.rate = rate; u.pitch = 1.0;
    highlightCurrent();
    updateProgress();
    u.onend = function(){ if (myGen !== gen || paused) return; qi++; speakNext(); };
    u.onerror = function(){
      if (myGen !== gen || paused) return;
      if (!fallback && localVoice && localVoice !== voice) { fallback = true; speakNext(); return; }
      qi++; speakNext();
    };
    synth.speak(u);
  }

  playBtn.addEventListener('click', function(){
    if (playing) { stop(); return; }
    if (!voice) refreshVoice();
    fallback = false;
    collect();
    var q = [];
    for (var i = 0; i < blocks.length; i++){
      var text = speakText(blocks[i]);
      chunk(text).forEach(function(t){ q.push({text: t, blockIndex: i}); });
    }
    queue = q; qi = 0;
    if (!queue.length) return;
    gen++;
    try { synth.cancel(); } catch(e){}
    setPlaying(true);
    speakNext();
  });

  pauseBtn.addEventListener('click', function(){
    if (!playing) return;
    if (!paused){
      setPaused(true);
      gen++;
      try { synth.cancel(); } catch(e){}
    } else {
      setPaused(false);
      speakNext();
    }
  });

  // Works while playing or paused (501e22eb): jump the position, and continue speaking only if
  // actively playing right now -- a jump while paused just moves the highlighted block and
  // leaves it paused there, same as jumping in most media players.
  function jumpToBlock(blockIndex){
    if (!queue.length) return;
    gen++;
    try { synth.cancel(); } catch(e){}
    qi = firstQueueIndexForBlock(blockIndex);
    currentSectionStart = sectionStartBlockIndex(queue[qi] ? queue[qi].blockIndex : blockIndex);
    sectionStartAt = Date.now();
    highlightCurrent();
    updateProgress();
    if (playing && !paused) speakNext();
  }
  if (skipBackBtn) skipBackBtn.addEventListener('click', function(){
    if (!playing || !queue.length) return;
    var curSectionStart = sectionStartBlockIndex(queue[qi] ? queue[qi].blockIndex : 0);
    var withinThreeSeconds = (Date.now() - sectionStartAt) < 3000;
    if (withinThreeSeconds){
      var heads = headingIndices(), prevHead = 0;
      for (var i = 0; i < heads.length; i++){ if (heads[i] < curSectionStart) prevHead = heads[i]; else break; }
      jumpToBlock(prevHead);
    } else {
      jumpToBlock(curSectionStart);
    }
  });
  if (skipFwdBtn) skipFwdBtn.addEventListener('click', function(){
    if (!playing || !queue.length) return;
    var curSectionStart = sectionStartBlockIndex(queue[qi] ? queue[qi].blockIndex : 0);
    var heads = headingIndices(), next = -1;
    for (var i = 0; i < heads.length; i++){ if (heads[i] > curSectionStart) { next = heads[i]; break; } }
    if (next === -1) { stop(); return; }
    jumpToBlock(next);
  });

  window.addEventListener('beforeunload', function(){ try { synth.cancel(); } catch(e){} });
})();
</script>`);
