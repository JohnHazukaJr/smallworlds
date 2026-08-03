const MOODS = {
  ember: { label: 'Ember', tint: 'rgba(224,165,95,0.16)', text: '#f2ece2', accent: 'oklch(0.83 0.1 58)', prose: '#ece2d4' },
  ash:   { label: 'Ash',   tint: 'rgba(160,175,200,0.14)', text: '#eef0f3', accent: 'oklch(0.84 0.04 250)', prose: '#e2e5ea' },
  frost: { label: 'Frost', tint: 'rgba(120,180,210,0.16)', text: '#e8f1f5', accent: 'oklch(0.85 0.07 215)', prose: '#dae7ee' },
  rot:   { label: 'Rot',   tint: 'rgba(150,190,130,0.14)', text: '#eaf0e4', accent: 'oklch(0.83 0.08 135)', prose: '#dfe7d4' }
};

const STRIPE = (a, b) => `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;

const VIS = {
  private: { label: 'Private', line: 'Only you. Never indexed, never shared, not used for training.' },
  invited: { label: 'Invited', line: 'A link you control. Readers can follow, not edit. Adult content stays gated.' },
  public: { label: 'Public', line: 'Listed on your profile. Others can read finished seasons and fork the world.' }
};

const WORLDS = [
  { id: 'registrar', title: 'The Registrar', art: 'harbour, night', tag: 'S2 · E7', line: 'A port where every debt is public record, and yours is written under a false name.', chapters: '2 seasons · 14 episodes', cast: '5 cast', words: '61k words', hue: 40, vis: 'private' },
  { id: 'salt', title: 'Salt in the Wires', art: 'flooded interior', tag: 'S1 · E3', line: 'The rig has been quiet for nine days. The crew keeps saying it is nine.', chapters: '1 season · 3 episodes', cast: '4 cast', words: '9k words', hue: 220, vis: 'private' },
  { id: 'hollowmere', title: 'Hollowmere', art: 'forest exterior', tag: 'S3 finale', line: 'The village agreed to forget. You are the only one who kept a diary.', chapters: '3 seasons · 26 episodes', cast: '9 cast', words: '88k words', hue: 140, vis: 'invited' },
  { id: 'winters', title: 'Fourteen Winters', art: 'portrait plate', tag: 'S4 · E2', line: 'You have written to her every winter since the border closed. She has answered twice.', chapters: '4 seasons · 31 episodes', cast: '2 cast', words: '112k words', hue: 300, vis: 'public' },
  { id: 'longroom', title: 'The Long Room', art: 'interior, lamplit', tag: 'draft', line: 'Untitled. One character, one room, an offer neither of you has named.', chapters: 'season 1 · unaired', cast: '1 cast', words: '2k words', hue: 20, vis: 'private' },
  { id: 'new', title: 'New world', art: 'blank slate', tag: 'start', line: 'One sentence about a place, a rule, or a pressure. I will take it from there.', chapters: '—', cast: '—', words: '—', hue: 250, vis: 'private' }
];

const BACKDROPS = {
  scene: { tag: 'scene plate · the long room, lamplit', a: 'rgba(70,54,38,0.75)', b: 'rgba(14,15,19,0.9)' },
  moment: { tag: 'moment plate · the manifest turned toward you', a: 'rgba(84,60,34,0.7)', b: 'rgba(12,13,17,0.92)' },
  character: { tag: 'character plate · the Cartwright, seated', a: 'rgba(52,48,66,0.72)', b: 'rgba(11,12,16,0.92)' },
  none: { tag: 'no backdrop · plain page', a: 'rgba(255,255,255,0.02)', b: 'rgba(8,9,12,0.98)' }
};

class Component extends DCLogic {
  state = {
    screen: 'library',
    layout: this.props.storyLayout ?? 'immersive',
    mood: 'ember',
    backdrop: 'scene',
    mode: 'steer',
    length: 'scene',
    engine: 'quill',
    byoProvider: 'anthropic',
    byoTested: false,
    imagery: 'hybrid',
    wrap: null,
    visibility: {},
    defaultVis: 'private',
    mature: this.props.matureDefault ?? true,
    castIdx: 0,
    photoTab: 'upload',
    beats: { 0: 'raise', 1: 'keep', 2: 'keep', 3: 'soften', 4: 'drop' },
    sequelKind: 'sequel',
    gap: 2,
    returning: { 0: true, 1: true, 2: false, 3: true },
    onboardStep: 0,
    onboardPick: 1,
    vw: typeof window !== 'undefined' ? window.innerWidth : 1440
  };

  componentDidMount() {
    this._onResize = () => this.setState({ vw: window.innerWidth });
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  componentWillUnmount() { window.removeEventListener('resize', this._onResize); }

  go = (screen) => () => this.setState({ screen });

  get mood() {
    const m = MOODS[this.state.mood];
    if (this.props.moodTheming === false) return { ...MOODS.ash, accent: this.props.accentColor || MOODS.ash.accent };
    return m;
  }

  navBtn(active) {
    return `display: flex; align-items: center; gap: 10px; text-align: left; border: 1px solid ${active ? 'rgba(255,255,255,0.12)' : 'transparent'}; border-radius: 11px; padding: 9px 11px; font-family: Archivo, sans-serif; font-size: 13.5px; cursor: pointer; background: ${active ? 'rgba(255,255,255,0.08)' : 'transparent'}; backdrop-filter: ${active ? 'blur(18px)' : 'none'}; color: ${active ? '#f8f6f2' : 'rgba(236,234,230,0.55)'}; font-weight: ${active ? 600 : 400};`;
  }

  chip(active, glass) {
    const a = glass ? this.mood.accent : 'oklch(0.85 0.1 62)';
    return `border: 1px solid ${active ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.11)'}; background: ${active ? a : 'rgba(255,255,255,0.05)'}; color: ${active ? '#181307' : 'rgba(236,234,230,0.62)'}; border-radius: 9px; padding: 7px 13px; font-size: 12px; font-weight: ${active ? 600 : 500}; font-family: Archivo, sans-serif; cursor: pointer; white-space: nowrap; backdrop-filter: blur(14px);`;
  }

  segBtn(active) {
    return `border: 0; background: ${active ? 'rgba(255,255,255,0.14)' : 'transparent'}; color: inherit; opacity: ${active ? 1 : 0.55}; padding: 7px 14px; font-size: 12px; font-weight: 600; font-family: Archivo, sans-serif; cursor: pointer;`;
  }

  bar(pct, color) {
    return `height: 100%; width: ${pct}%; background: ${color || 'oklch(0.85 0.1 62)'}; border-radius: 2px;`;
  }

  glassCard(activeTone) {
    return `border: 1px solid ${activeTone ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.09)'}; border-radius: 16px; background: ${activeTone ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.045)'}; backdrop-filter: blur(20px) saturate(140%);`;
  }

  renderVals() {
    const s = this.state;
    const M = this.mood;
    const accent = this.props.accentColor || 'oklch(0.85 0.1 62)';
    const narrow = s.vw < 780;
    const director = s.layout === 'director' && s.vw >= 940;
    const BD = BACKDROPS[s.backdrop] || BACKDROPS.scene;

    const nav = [
      ['01', 'Worlds', 'library'], ['02', 'Story', 'story'], ['03', 'Cast', 'cast'],
      ['04', 'Next season', 'sequel'], ['05', 'Profile', 'profile'], ['06', 'Settings', 'settings'], ['07', 'New world', 'onboard']
    ].map(([num, label, key]) => ({ num, label, go: this.go(key), style: this.navBtn(s.screen === key) }));

    const engines = [
      { id: 'quill', name: 'Quill 3 — Longform', cost: '1× credits', line: 'House model. Best continuity across long chapters; holds voice for dozens of scenes.', stats: [['prose', 88], ['memory', 94], ['speed', 62]] },
      { id: 'vellum', name: 'Vellum Instruct', cost: '0.6× credits', line: 'Fast and obedient. Follows steering literally — good when you are directing hard.', stats: [['prose', 66], ['memory', 70], ['speed', 95]] },
      { id: 'noir', name: 'Noir 70B (uncensored)', cost: '1.4× credits', line: 'Open weights, no refusals. Rawer prose, needs a firmer hand on continuity.', stats: [['prose', 78], ['memory', 58], ['speed', 74]] },
      { id: 'byo', name: 'Bring your own key', cost: 'billed to you', line: 'Any OpenAI-compatible endpoint. Anchors, memory and sequel review still apply.', stats: [['prose', 50], ['memory', 84], ['speed', 70]] }
    ];
    const engine = engines.find(e => e.id === s.engine) || engines[0];

    const BYO = {
      anthropic: { url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
      openai: { url: 'https://api.openai.com/v1', model: 'gpt-4.1' },
      openrouter: { url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b' },
      together: { url: 'https://api.together.xyz/v1', model: 'mistralai/Mixtral-8x22B' },
      custom: { url: 'http://localhost:8080/v1', model: 'your-model-name' }
    };
    const byoP = BYO[s.byoProvider] || BYO.anthropic;

    const cast = [
      { name: 'Marisol Vey', role: 'harbour registrar · reluctant ally', hue: 26 },
      { name: 'Ivo Tarrant', role: 'brother · owes the guild', hue: 210 },
      { name: 'The Cartwright', role: 'unknown · speaks in trades', hue: 280 },
      { name: 'Emine', role: 'child of the low quarter', hue: 140 },
      { name: 'you', role: 'protagonist · second person', hue: 60 }
    ];
    const active = cast[s.castIdx] || cast[0];
    const avatar = (hue, size, ring) => `width: ${size}px; height: ${size}px; border-radius: ${size > 30 ? '12px' : '50%'}; flex-shrink: 0; border: 1px solid ${ring || 'rgba(255,255,255,0.16)'}; background: linear-gradient(150deg, oklch(0.6 0.08 ${hue}), rgba(255,255,255,0.06)), ${STRIPE('rgba(255,255,255,0.1)', 'rgba(255,255,255,0.02)')}; box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);`;

    const proseData = [
      { t: 'The long room keeps its own weather. Lamp-smoke gathers along the ceiling beams and stays there, and the tide sound comes up through the floor rather than the windows, so that every conversation held here has the shape of something overheard.' },
      { t: 'The Cartwright has not touched the cup you poured. That is the first thing you notice. The second is that he has arranged the manifest pages so the false signature faces you.', dim: true },
      { t: '"You write a steady hand. Steadier than the name deserves."', speaker: 'The Cartwright', hue: 280 },
      { t: 'You could tell him the truth. You could tell him a better lie. Marisol is on the tide stairs outside and will hear either one, because the long room keeps its own weather and gives nothing back.' },
      { t: '"I write what the harbour will accept."', speaker: 'you', hue: 60 },
      { t: '"Then write it again," she says from the doorway, "and put your own name on it."', speaker: 'Marisol Vey', hue: 26 },
      { t: 'The Cartwright turns a page over, unhurried, the way a man does when the outcome was never in question — and lets the silence do the work you were hoping to do yourself.', dim: true }
    ];

    const beatData = [
      { where: 'S2 · E5 · the customs house', text: 'You signed the manifest under a false name.', consequence: 'Marisol saw the signature and said nothing.' },
      { where: 'S2 · E6 · the low quarter', text: 'Ivo took guild money to cover your debt.', consequence: 'He has not told you the terms.' },
      { where: 'S2 · E6 · the tide stairs', text: 'You told Marisol the truth about the cargo.', consequence: 'She has been careful with you since.' },
      { where: 'S2 · E7 · the long room', text: 'The Cartwright offered a second trade.', consequence: 'Unanswered when the season ended.' },
      { where: 'S2 · E7 · dockside', text: 'A watchman recognised you and walked on.', consequence: 'Ambient. Probably nothing.' }
    ];
    const beatOpts = [['drop', 'Drop'], ['soften', 'Soften'], ['keep', 'Keep'], ['raise', 'Raise']];
    const beats = beatData.map((b, i) => {
      const cur = s.beats[i] || 'keep';
      const hot = cur === 'raise';
      return {
        ...b,
        cardStyle: this.glassCard(hot) + ` padding: 16px 18px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; opacity: ${cur === 'drop' ? 0.42 : 1};`,
        options: beatOpts.map(([id, label]) => ({
          label,
          pick: () => this.setState(st => ({ beats: { ...st.beats, [i]: id } })),
          style: this.chip(cur === id)
        }))
      };
    });
    const raised = Object.values(s.beats).filter(v => v === 'raise').length;
    const dropped = Object.values(s.beats).filter(v => v === 'drop').length;

    const gapLabels = ['That same night', 'Three days', 'A season', 'Two years', 'A generation'];
    const gapEffects = [
      'Nothing has settled. Wounds, debts and tempers carry straight over.',
      'Enough for rumours to move. Characters have had time to decide how they feel.',
      'The harbour has changed hands once. Relationships cooled or hardened.',
      'People became who the last chapter pointed them at. Old debts are now other people\u2019s problems.',
      'Your protagonist may be a story others tell. Consider starting as someone new.'
    ];

    const onboard = [
      {
        title: 'Start from nothing.',
        body: 'Small Worlds does not hand you a story. It gives you a world that behaves consistently and characters who hold their own line — then gets out of the way while you write into it.',
        cta: 'Next — the world',
        options: [
          { label: 'One long story I keep returning to', line: 'Seasons, episodes, a cast that ages and remembers.' },
          { label: 'A world I want to wander', line: 'Loose scenes, many characters, no fixed plot.' },
          { label: 'A single character I want to know', line: 'One person, deeply modelled, many conversations.' },
          { label: 'I want to see what happens', line: 'Start blank. Decide later.' }
        ]
      },
      {
        title: 'Give the world one true thing.',
        body: 'A place, a rule, a pressure. One sentence is enough — I will ask about the rest as the story needs it, rather than making you fill in a form now.',
        cta: 'Next — the first character',
        options: [
          { label: 'A place', line: 'Somewhere with its own weather and its own rules.' },
          { label: 'A rule', line: 'Something in this world cannot be undone.' },
          { label: 'A pressure', line: 'Something is coming and everyone knows it.' },
          { label: 'Paste a document', line: 'Notes, a wiki, an old draft — I will read it into a world.' }
        ]
      },
      {
        title: 'Who is in it with you?',
        body: 'Give them a face and a few anchors. Photos hold their look across every generated image; anchors hold their behaviour across every chapter — that is what stops them dissolving into an agreeable assistant.',
        cta: 'Enter the world',
        options: [
          { label: 'Upload reference photos', line: 'Two to six images. Face stays consistent in scene art.' },
          { label: 'Generate a portrait', line: 'Describe them; pick from a sheet; lock the face.' },
          { label: 'Write them first, look later', line: 'Voice and anchors now, face when you need it.' },
          { label: 'Only me for now', line: 'Second person, no cast yet.' }
        ]
      }
    ];
    const ob = onboard[s.onboardStep];

    return {
      shellStyle: narrow
        ? 'position: relative; z-index: 1; min-height: 100vh; display: block;'
        : 'position: relative; z-index: 1; min-height: 100vh; display: grid; grid-template-columns: 226px minmax(0, 1fr);',
      railStyle: narrow
        ? 'border-bottom: 1px solid rgba(255,255,255,0.08); padding: 13px 15px; display: flex; flex-direction: column; gap: 13px; position: sticky; top: 0; z-index: 20; background: rgba(8,9,12,0.7); backdrop-filter: blur(24px) saturate(140%);'
        : 'border-right: 1px solid rgba(255,255,255,0.07); padding: 22px 15px; display: flex; flex-direction: column; gap: 26px; position: sticky; top: 0; height: 100vh; background: rgba(255,255,255,0.025); backdrop-filter: blur(24px) saturate(140%);',
      navListStyle: narrow
        ? 'display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px;'
        : 'display: flex; flex-direction: column; gap: 3px;',
      railFootStyle: narrow ? 'display: none;' : 'margin-top: auto; display: flex; flex-direction: column; gap: 14px;',
      nav,
      engineName: engine.name,
      creditBarStyle: this.bar(64, accent),
      creditLabel: '3,180 credits · ~26 scenes',
      isLibrary: s.screen === 'library',
      isStory: s.screen === 'story',
      isCast: s.screen === 'cast',
      isSequel: s.screen === 'sequel',
      isSettings: s.screen === 'settings',
      isProfile: s.screen === 'profile',
      isOnboard: s.screen === 'onboard',
      goLibrary: this.go('library'),
      goOnboard: this.go('onboard'),
      goSequel: this.go('sequel'),

      filters: ['All 7', 'Writing now', 'Waiting on you', 'Shared with me', 'Adult'].map((label, i) => ({
        label,
        style: `border: 1px solid ${i === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.09)'}; color: ${i === 0 ? '#f4f2ee' : 'rgba(236,234,230,0.5)'}; background: rgba(255,255,255,${i === 0 ? '0.08' : '0.03'}); backdrop-filter: blur(14px); border-radius: 20px; padding: 7px 15px; font-size: 12px; cursor: pointer;`
      })),

      worlds: WORLDS.map(w => ({
        ...w,
        open: this.go('story'),
        privacyStyle: `display: flex; align-items: center; gap: 5px; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(236,234,230,0.5); background: rgba(8,9,12,0.5); backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 6px;`,
        privacyLabel: VIS[s.visibility[w.id] || w.vis].label,
        artStyle: `height: 138px; display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; padding: 12px; background: linear-gradient(155deg, oklch(0.45 0.06 ${w.hue} / 0.75), rgba(8,9,12,0.85)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')};`,
        tagStyle: 'font-family: \'IBM Plex Mono\', monospace; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(236,234,230,0.55); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 3px 7px; white-space: nowrap;'
      })),

      prompts: [
        { where: 'The Registrar · season 2 finale', text: 'Ready to review what mattered and open season 3.', cta: 'Review season', go: this.go('sequel') },
        { where: 'Hollowmere · Emine', text: 'Emine has been off-page for a season and a half. Retire her, or bring her back changed?', cta: 'Decide', go: this.go('cast') },
        { where: 'Salt in the Wires · continuity', text: 'Two episodes contradict how long the rig has been quiet. I can reconcile it.', cta: 'Show conflict', go: this.go('story') }
      ],

      storyShellStyle: `position: relative; min-height: 100vh; display: flex; flex-direction: column; color: ${M.text};`,
      backdropStyle: `position: absolute; inset: 0; z-index: 0; background: linear-gradient(160deg, ${BD.a}, ${BD.b}), ${STRIPE('rgba(255,255,255,0.05)', 'rgba(255,255,255,0.01)')}; opacity: ${s.backdrop === 'none' ? 0.25 : 1}; transition: opacity 0.5s ease;`,
      backdropScrimStyle: `position: absolute; inset: 0; z-index: 1; pointer-events: none; background: radial-gradient(720px 520px at 50% 40%, transparent, rgba(8,9,12,0.72) 78%), linear-gradient(180deg, rgba(8,9,12,0.5), rgba(8,9,12,0.2) 30%, rgba(8,9,12,0.6)); backdrop-filter: blur(3px);`,
      backdropTagStyle: `position: absolute; z-index: 2; bottom: 96px; right: 22px; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.1em; color: rgba(236,234,230,0.5); background: rgba(8,9,12,0.5); border: 1px solid rgba(255,255,255,0.09); backdrop-filter: blur(10px); padding: 5px 9px; border-radius: 6px; display: ${narrow ? 'none' : 'block'};`,
      backdropTag: BD.tag,
      openWrap: () => this.setState({ wrap: 'episode' }),
      closeWrap: () => this.setState({ wrap: null }),
      wrapScrimStyle: `position: fixed; inset: 0; z-index: 30; background: rgba(6,7,10,0.55); backdrop-filter: blur(4px); display: ${s.wrap ? 'block' : 'none'};`,
      wrapSheetStyle: `position: fixed; top: 0; right: 0; bottom: 0; z-index: 31; width: ${narrow ? '100%' : '440px'}; display: ${s.wrap ? 'flex' : 'none'}; flex-direction: column; gap: 16px; padding: 22px 22px 20px; border-left: 1px solid rgba(255,255,255,0.12); background: rgba(14,16,20,0.72); backdrop-filter: blur(30px) saturate(150%); box-shadow: -30px 0 80px rgba(0,0,0,0.5); color: ${M.text}; animation: wr-fade 0.25s ease both;`,
      wrapScopes: [['episode', 'End episode'], ['season', 'End season']].map(([id, label]) => ({
        label, pick: () => this.setState({ wrap: id }), style: this.chip(s.wrap === id, true)
      })),
      wrapKicker: s.wrap === 'season' ? 'season 2 · finale' : 'season 2 · episode 7',
      wrapTitle: s.wrap === 'season' ? 'Close the season.' : 'Wrap this episode.',
      wrapBody: s.wrap === 'season'
        ? 'I read the whole season back. Mark what carries into season 3 — raise it and the cast arrives already carrying it.'
        : 'Here is what happened this episode. Anything you raise is what the next one opens on.',
      wrapBeatsLabel: s.wrap === 'season' ? 'the season, as I read it' : 'this episode, as I read it',
      wrapBeats: (s.wrap === 'season' ? beats : beats.slice(3)).map(b => ({
        ...b,
        cardStyle: 'border: 1px solid rgba(255,255,255,0.1); border-radius: 13px; background: rgba(255,255,255,0.05); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;'
      })),
      wrapGapStyle: `display: ${s.wrap === 'season' ? 'flex' : 'none'}; flex-direction: column; gap: 8px;`,
      wrapPremise: s.wrap === 'season'
        ? 'Season three opens ' + gapLabels[s.gap].toLowerCase() + ' later — ' + (raised ? raised + ' raised beat(s) carried, ' : '') + dropped + ' left in the past.'
        : 'Episode 8 opens in the long room, with the trade still on the table.',
      wrapCta: s.wrap === 'season' ? 'Begin season 3' : 'Start episode 8',
      wrapPrimary: () => s.wrap === 'season' ? this.setState({ screen: 'sequel', wrap: null }) : this.setState({ wrap: null }),
      backdropModes: [['scene', 'Scene'], ['moment', 'Moment'], ['character', 'Character'], ['none', 'Off']].map(([id, label]) => ({
        label, pick: () => this.setState({ backdrop: id }), style: this.chip(s.backdrop === id, true)
      })),
      storyBodyStyle: 'position: relative; z-index: 2; flex: 1; display: grid; min-height: 0; grid-template-columns: ' + (
        director ? (s.vw >= 1240 ? '252px minmax(0, 1fr) 264px' : '238px minmax(0, 1fr)') : 'minmax(0, 1fr)'
      ) + ';',
      isDirector: director,
      showBeatsPanel: director && s.vw >= 1240,
      moodDotStyle: `width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: ${M.accent}; box-shadow: 0 0 16px ${M.accent};`,
      storyTitle: 'The Registrar',
      storyMeta: 'season 2 · episode 7 · the long room · ' + M.label.toLowerCase(),
      chapterLabel: 'season two, episode seven — the long room',
      layouts: (s.vw >= 940 ? [['immersive', 'Read'], ['director', 'Direct']] : [['immersive', 'Read']]).map(([id, label]) => ({
        label, pick: () => this.setState({ layout: id }), style: this.segBtn(s.layout === id)
      })),
      moods: Object.entries(MOODS).map(([id, m]) => ({
        label: m.label,
        pick: () => this.setState({ mood: id }),
        style: `width: 13px; height: 13px; border-radius: 50%; cursor: pointer; background: ${m.accent}; border: 1px solid ${s.mood === id ? 'rgba(255,255,255,0.85)' : 'transparent'}; opacity: ${s.mood === id ? 1 : 0.45}; padding: 0;`
      })),
      proseColStyle: `max-width: ${director ? '680px' : '740px'}; margin: 0 auto; padding: ${director ? '32px 30px 56px' : '52px 28px 76px'};`,
      prose: proseData.map(p => {
        const isDialog = !!p.speaker;
        return {
          text: p.t,
          speaker: p.speaker || '',
          rowStyle: `display: flex; gap: 14px; align-items: flex-start; margin-bottom: ${isDialog ? '24px' : '22px'};`,
          avatarStyle: isDialog
            ? avatar(p.hue, 34, 'rgba(255,255,255,0.2)') + ' margin-top: 4px;'
            : 'display: none;',
          blockStyle: isDialog
            ? `flex: 1; min-width: 0; border-left: 1px solid ${M.accent}55; padding-left: 14px;`
            : 'flex: 1; min-width: 0;',
          nameStyle: isDialog
            ? `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: ${M.accent}; margin-bottom: 6px;`
            : 'display: none;',
          style: `font-family: Spectral, serif; font-size: ${director ? '17.5px' : '19px'}; line-height: 1.78; margin: 0; color: ${M.prose}; opacity: ${p.dim ? 0.84 : 1}; text-wrap: pretty; ${isDialog ? 'font-style: italic;' : ''}`
        };
      }),
      typingStyle: `width: 5px; height: 5px; border-radius: 50%; background: ${M.accent}; box-shadow: 12px 0 0 ${M.accent}80, 24px 0 0 ${M.accent}40;`,
      writingLabel: engine.name.split(' — ')[0] + ' is writing the next beat',

      sceneCast: cast.slice(0, 3).map((c, i) => ({
        name: c.name,
        state: ['in the doorway · wary', 'across the table · unhurried', 'off-page · 2 chapters'][i],
        focus: () => this.setState({ backdrop: 'character' }),
        rowStyle: 'display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 12px; cursor: pointer; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);',
        avatarStyle: avatar(c.hue, 30)
      })),
      sceneArtStyle: `height: 98px; display: flex; align-items: flex-end; padding: 9px; background: linear-gradient(155deg, ${BD.a}, ${BD.b}), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')};`,
      sceneWhere: 'The long room, above the customs house. Lamplit, tide-loud, one door.',
      profileVis: Object.entries(VIS).map(([id, v]) => ({
        label: v.label, line: v.line,
        pick: () => this.setState({ defaultVis: id }),
        style: `text-align: left; display: flex; flex-direction: column; gap: 5px; border: 1px solid rgba(255,255,255,${s.defaultVis === id ? '0.2' : '0.09'}); background: ${s.defaultVis === id ? 'linear-gradient(150deg, rgba(224,165,95,0.13), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)'}; color: ${s.defaultVis === id ? '#f6f4f0' : 'rgba(236,234,230,0.62)'}; border-radius: 13px; padding: 13px 15px; cursor: pointer; font-family: Archivo, sans-serif; backdrop-filter: blur(14px);`
      })),
      profileWorlds: WORLDS.filter(w => w.id !== 'new').map(w => {
        const cur = s.visibility[w.id] || w.vis;
        return {
          title: w.title,
          meta: w.chapters,
          plateStyle: `width: 46px; height: 46px; border-radius: 12px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.12); background: linear-gradient(155deg, oklch(0.5 0.06 ${w.hue} / 0.8), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.08)', 'rgba(255,255,255,0.02)')};`,
          options: Object.entries(VIS).map(([id, v]) => ({
            label: v.label,
            pick: () => this.setState(st => ({ visibility: { ...st.visibility, [w.id]: id } })),
            style: this.chip(cur === id)
          }))
        };
      }),
      profileStats: [
        { k: 'worlds', v: '5' },
        { k: 'seasons written', v: '11' },
        { k: 'words', v: '272k' },
        { k: 'cast created', v: '21' },
        { k: 'public', v: '1' }
      ],
      profileAvatarStyle: avatar(60, 84, 'rgba(255,255,255,0.2)'),
      profileHandle: '@yourhandle',
      profileName: 'Your name',
      profileBio: 'Writes slow harbour fiction and one long-running thing about a village that agreed to forget. Mostly private worlds; ask me about Fourteen Winters.',
      profileToggles: [
        { label: 'Show my worlds on my profile', value: '1 of 5 public', on: true },
        { label: 'Let others fork public worlds', value: 'credit kept', on: true },
        { label: 'Use my writing to improve models', value: 'never', on: false },
        { label: 'Adult worlds visible to invited readers', value: 'age-gated link', on: true }
      ].map(t => ({
        ...t,
        trackStyle: `width: 42px; height: 24px; border-radius: 13px; flex-shrink: 0; border: 1px solid rgba(255,255,255,${t.on ? '0.2' : '0.12'}); background: ${t.on ? accent : 'rgba(255,255,255,0.06)'}; padding: 3px; display: flex; justify-content: ${t.on ? 'flex-end' : 'flex-start'};`,
        knobStyle: `width: 16px; height: 16px; border-radius: 50%; background: ${t.on ? '#1a1409' : 'rgba(236,234,230,0.5)'};`
      })),
      continuity: [
        'Your name on the manifest is false and Marisol knows.',
        'Ivo\u2019s guild debt is unspoken between you.',
        'The Cartwright trades, never threatens.',
        'You have not drunk in this room since S1 · E9.'
      ],
      threads: [
        { text: 'The Cartwright\u2019s second trade is still unanswered.', age: 'opened S2 · E7' },
        { text: 'Ivo has not told you the terms.', age: 'opened S2 · E6' },
        { text: 'Emine saw you at the tide stairs.', age: 'opened S1 · E9 · cooling' }
      ],
      nudges: [
        'Let the silence run — do not fill it for me.',
        'The Cartwright names a price you cannot pay.',
        'Marisol stays in the doorway; she does not come in.',
        'Cut to the tide stairs, after.'
      ],
      modes: [['continue', 'Continue'], ['steer', 'Steer'], ['speak', 'Speak'], ['act', 'Act']].map(([id, label]) => ({
        label, pick: () => this.setState({ mode: id }), style: this.chip(s.mode === id, true)
      })),
      lengths: [['beat', 'Beat'], ['scene', 'Scene'], ['episode', 'Episode']].map(([id, label]) => ({
        label, pick: () => this.setState({ length: id }), style: this.chip(s.length === id, true)
      })),
      composerStyle: 'display: flex; gap: 13px; align-items: flex-start; border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; padding: 14px 16px; background: rgba(255,255,255,0.06); backdrop-filter: blur(20px) saturate(140%);',
      composerSpeakerStyle: s.mode === 'speak' || s.mode === 'act' ? avatar(60, 30, 'rgba(255,255,255,0.22)') + ' margin-top: 2px;' : 'display: none;',
      modeHint: { continue: 'continue', steer: 'you direct', speak: 'you say', act: 'you do' }[s.mode],
      composerPlaceholder: {
        continue: 'Press write on — I take the next beat from here.',
        steer: 'Tell me what should happen, in your words. I keep everyone in character while doing it.',
        speak: '"..." — dialogue only. I will not put words in your mouth beyond this.',
        act: 'You do something. No dialogue, no narration from you.'
      }[s.mode],
      maturityLabel: s.mature ? 'adult world · unrestricted' : 'general audience',

      castShellStyle: 'display: grid; min-height: 100vh; animation: wr-fade 0.45s ease both; grid-template-columns: ' + (s.vw < 900 ? 'minmax(0, 1fr)' : '264px minmax(0, 1fr)') + ';',
      cast: cast.map((c, i) => ({
        name: c.name, role: c.role,
        pick: () => this.setState({ castIdx: i }),
        rowStyle: `display: flex; gap: 10px; align-items: center; padding: 9px; border-radius: 13px; cursor: pointer; background: rgba(255,255,255,${s.castIdx === i ? '0.08' : '0'}); border: 1px solid ${s.castIdx === i ? 'rgba(255,255,255,0.14)' : 'transparent'}; backdrop-filter: ${s.castIdx === i ? 'blur(18px)' : 'none'};`,
        avatarStyle: avatar(c.hue, 34)
      })),
      activeName: active.name,
      activeRole: active.role,
      heroPhotoStyle: `height: 306px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.12); display: flex; align-items: flex-end; padding: 12px; background: linear-gradient(155deg, oklch(0.5 0.06 ${active.hue} / 0.7), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')};`,
      photoTabs: [['upload', 'Upload'], ['generate', 'Generate']].map(([id, label]) => ({
        label, pick: () => this.setState({ photoTab: id }), style: this.chip(s.photoTab === id)
      })),
      photoSlots: [0, 1, 2, 3].map(i => ({
        style: `aspect-ratio: 1; border-radius: 9px; border: 1px ${i < 3 ? 'solid rgba(255,255,255,0.12)' : 'dashed rgba(255,255,255,0.18)'}; background: ${i < 3 ? STRIPE('rgba(255,255,255,0.09)', 'rgba(255,255,255,0.02)') : 'rgba(255,255,255,0.02)'};`
      })),
      photoHint: s.photoTab === 'upload'
        ? '3 of 6 references · face locked. Backdrops and scene art reuse this identity.'
        : 'Describe her, generate a sheet, lock one face as canon.',
      traits: [
        { k: 'speech', v: 'Short sentences. Answers the question under the question.' },
        { k: 'age / read', v: 'Late thirties. Tired in a competent way.' },
        { k: 'wants', v: 'The harbour to stay boring.' },
        { k: 'will not', v: 'Lie in writing. Ever.' }
      ],
      castTabs: [['persona', 'Persona'], ['voice', 'Voice'], ['images', 'Images'], ['memory', 'Memory'], ['relations', 'Relations'], ['limits', 'Limits']].map(([id, label], i) => ({
        label, pick: () => {}, style: `border: 0; background: transparent; color: ${i === 0 ? '#f8f6f2' : 'rgba(236,234,230,0.45)'}; border-bottom: 2px solid ${i === 0 ? accent : 'transparent'}; padding: 10px 14px; font-size: 13px; font-weight: 600; font-family: Archivo, sans-serif; cursor: pointer;`
      })),
      castFields: [
        { label: 'Who she is', note: 'prose, not bullet points', value: 'Registrar of the harbour customs house for eleven years. Keeps the debt ledger, which means she knows more about this city than anyone who lives well in it. She is not a good person or a bad one; she is a person with a job she is unwilling to do badly.' },
        { label: 'How she speaks', note: 'I imitate rhythm, not vocabulary', value: 'Clipped. Rarely finishes a thought aloud if a look will do it. Uses your name when she is being serious and does not use it otherwise.' },
        { label: 'What she has not said', note: 'drives subtext, never stated outright', value: 'She saw the false signature in chapter 12 and chose silence. She has not decided what that makes her.' }
      ].map(f => ({
        ...f,
        boxStyle: 'border: 1px solid rgba(255,255,255,0.09); border-radius: 14px; padding: 14px 16px; background: rgba(255,255,255,0.04); backdrop-filter: blur(18px); font-family: Spectral, serif; font-size: 15.5px; line-height: 1.7; color: rgba(236,234,230,0.85); text-wrap: pretty;'
      })),
      anchors: [
        { n: '01', text: 'Never lies in writing. Will omit, will refuse, will not falsify.' },
        { n: '02', text: 'Does not warm to you quickly. Trust moves one notch per episode at most.' },
        { n: '03', text: 'Will not be the one to name what is between you.' },
        { n: '04', text: 'If cornered, she goes procedural — the ledger, the forms, the rules.' }
      ],

      sequelSteps: ['What mattered', 'How it continues', 'Who returns'].map((label, i) => ({
        label, n: '0' + (i + 1),
        style: `display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,${i === 0 ? '0.2' : '0.09'}); background: ${i === 0 ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)'}; backdrop-filter: blur(16px); color: ${i === 0 ? '#f4f2ee' : 'rgba(236,234,230,0.5)'}; border-radius: 20px; padding: 8px 16px; font-size: 12.5px; font-weight: 600;`
      })),
      beats,
      sequelKinds: [
        { id: 'sequel', label: 'Next episode', line: 'Same season, straight on. Everything raised carries over.' },
        { id: 'season', label: 'New season', line: 'A time jump and a fresh arc. Last season becomes backstory the cast remembers.' },
        { id: 'branch', label: 'Branch from a beat', line: 'Rewind to any moment and take the other road. The original season stays intact.' }
      ].map(k => ({
        ...k,
        pick: () => this.setState({ sequelKind: k.id }),
        style: `text-align: left; display: flex; flex-direction: column; gap: 5px; border: 1px solid rgba(255,255,255,${s.sequelKind === k.id ? '0.2' : '0.09'}); background: ${s.sequelKind === k.id ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)'}; color: ${s.sequelKind === k.id ? '#f6f4f0' : 'rgba(236,234,230,0.62)'}; border-radius: 13px; padding: 13px 15px; cursor: pointer; font-family: Archivo, sans-serif; backdrop-filter: blur(14px);`
      })),
      gapLabel: gapLabels[s.gap],
      gaps: gapLabels.map((label, i) => ({
        label, pick: () => this.setState({ gap: i }), style: this.chip(s.gap === i)
      })),
      gapEffect: gapEffects[s.gap],
      returning: cast.slice(0, 4).map((c, i) => {
        const on = !!s.returning[i];
        return {
          name: c.name,
          state: ['carries the false name', 'in debt to the guild', 'trade left open', 'grown, harder'][i],
          toggle: () => this.setState(st => ({ returning: { ...st.returning, [i]: !st.returning[i] } })),
          style: `display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 12px; cursor: pointer; border: 1px solid rgba(255,255,255,${on ? '0.14' : '0.06'}); background: rgba(255,255,255,${on ? '0.06' : '0'}); opacity: ${on ? 1 : 0.45};`,
          avatarStyle: avatar(c.hue, 28),
          checkStyle: `margin-left: auto; width: 16px; height: 16px; border-radius: 6px; flex-shrink: 0; border: 1px solid ${on ? accent : 'rgba(255,255,255,0.18)'}; background: ${on ? accent : 'transparent'};`
        };
      }),
      sequelPremise: 'Season three. Two years on, the ledger has a new registrar and your false name has become someone else\u2019s problem — until a manifest surfaces in Marisol\u2019s handwriting, signed with it.',
      beatSummary: raised + ' raised · ' + dropped + ' dropped · 5 beats reviewed',

      engines: engines.map(e => ({
        name: e.name, cost: e.cost, line: e.line,
        pick: () => this.setState({ engine: e.id }),
        style: this.glassCard(s.engine === e.id) + ' display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 18px; cursor: pointer;',
        radioStyle: `width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0; border: 1px solid ${s.engine === e.id ? accent : 'rgba(255,255,255,0.2)'}; background: ${s.engine === e.id ? accent : 'transparent'}; box-shadow: ${s.engine === e.id ? 'inset 0 0 0 3px rgba(8,9,12,0.9)' : 'none'};`,
        stats: e.stats.map(([k, v]) => ({ k, barStyle: this.bar(v, s.engine === e.id ? accent : 'rgba(255,255,255,0.28)') }))
      })),

      byoPanelStyle: `display: ${s.engine === 'byo' ? 'flex' : 'none'}; flex-direction: column; gap: 14px; border: 1px solid rgba(255,255,255,0.14); border-radius: 18px; padding: 20px 22px; background: linear-gradient(150deg, rgba(224,165,95,0.1), rgba(255,255,255,0.04)); backdrop-filter: blur(22px) saturate(140%); margin-bottom: 34px;`,
      byoStatus: s.byoTested ? 'connected' : 'not verified',
      byoStatusStyle: `font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; border-radius: 6px; padding: 3px 8px; border: 1px solid rgba(255,255,255,0.16); color: ${s.byoTested ? 'oklch(0.85 0.09 140)' : accent};`,
      byoProviders: [
        ['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'],
        ['together', 'Together'], ['custom', 'Custom endpoint']
      ].map(([id, label]) => ({
        label, pick: () => this.setState({ byoProvider: id, byoTested: false }), style: this.chip(s.byoProvider === id)
      })),
      byoFields: [
        { label: 'base url', value: byoP.url },
        { label: 'api key', value: 'sk-•••• •••• •••• 4f2a' },
        { label: 'model', value: byoP.model }
      ].map(f => ({
        ...f,
        boxStyle: 'border: 1px solid rgba(255,255,255,0.11); border-radius: 11px; padding: 11px 13px; background: rgba(8,9,12,0.5); font-family: \'IBM Plex Mono\', monospace; font-size: 12px; color: rgba(236,234,230,0.85); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
      })),
      byoTest: () => this.setState(st => ({ byoTested: !st.byoTested })),
      byoTestLabel: s.byoTested ? 'Re-test connection' : 'Test connection',
      byoLatency: s.byoTested ? 'last check: 340ms · 200 OK · streaming supported' : 'run a test before writing a chapter',
      byoNotes: [
        'Per-world override: house models for casual worlds, your own key for the long one.',
        'If your endpoint refuses a request, Small Worlds shows the provider\u2019s own error rather than silently rewriting the scene.',
        'Image keys are separate — point avatars and backdrops at your own image endpoint too.'
      ],

      imageryModes: [
        { id: 'uploads', label: 'My uploads only', line: 'Nothing is generated. Backdrops come from what you add.' },
        { id: 'hybrid', label: 'Uploads, then generate', line: 'Use your art where it exists; generate the gaps in that style.' },
        { id: 'generate', label: 'Generate everything', line: 'A plate per scene, moment and character, identity locked.' }
      ].map(i => ({
        label: i.label, line: i.line,
        pick: () => this.setState({ imagery: i.id }),
        style: `text-align: left; display: flex; flex-direction: column; gap: 5px; border: 1px solid rgba(255,255,255,${s.imagery === i.id ? '0.2' : '0.09'}); background: ${s.imagery === i.id ? 'linear-gradient(150deg, rgba(224,165,95,0.14), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)'}; color: ${s.imagery === i.id ? '#f6f4f0' : 'rgba(236,234,230,0.62)'}; border-radius: 13px; padding: 13px 15px; cursor: pointer; font-family: Archivo, sans-serif; backdrop-filter: blur(14px);`
      })),

      toggleMature: () => this.setState(st => ({ mature: !st.mature })),
      matureTrackStyle: `width: 46px; height: 26px; border-radius: 14px; border: 1px solid rgba(255,255,255,${s.mature ? '0.2' : '0.12'}); background: ${s.mature ? accent : 'rgba(255,255,255,0.06)'}; cursor: pointer; padding: 3px; display: flex; justify-content: ${s.mature ? 'flex-end' : 'flex-start'}; transition: all 0.2s ease;`,
      matureKnobStyle: `width: 18px; height: 18px; border-radius: 50%; background: ${s.mature ? '#1a1409' : 'rgba(236,234,230,0.5)'};`,
      maturePanelStyle: `display: ${s.mature ? 'flex' : 'none'}; flex-direction: column; gap: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 16px;`,
      matureLevers: [
        { label: 'Explicit sex', value: 'allowed · fade optional' },
        { label: 'Adult worlds are private', value: 'enforced' },
        { label: 'Graphic violence', value: 'allowed' },
        { label: 'Per-character limits', value: '2 characters have hard limits' },
        { label: 'Shared links', value: 'always SFW' }
      ],
      proseControls: [
        { label: 'Purple-ness', value: 'restrained', pct: 32, note: 'Concrete over ornamental. Few adverbs.' },
        { label: 'Pacing', value: 'scene-length', pct: 58, note: 'Roughly 400 words per continue.' },
        { label: 'Memory depth', value: 'full world', pct: 92, note: 'Every season summarised, last 3 episodes verbatim.' },
        { label: 'Character drift guard', value: 'strict', pct: 84, note: 'Drafts that break anchors are rewritten silently.' }
      ].map(c => ({ ...c, barStyle: this.bar(c.pct, accent) })),

      onboardShellStyle: 'min-height: 100vh; display: grid; animation: wr-fade 0.45s ease both; grid-template-columns: ' + (s.vw < 1000 ? 'minmax(0, 1fr)' : '1.05fr 1fr') + ';',
      onboardSteps: [0, 1, 2].map(i => ({
        style: `width: ${i === s.onboardStep ? '26px' : '9px'}; height: 4px; border-radius: 2px; background: ${i <= s.onboardStep ? accent : 'rgba(255,255,255,0.14)'}; transition: all 0.3s ease;`
      })),
      onboardStepLabel: 'step ' + (s.onboardStep + 1) + ' of 3',
      onboardTitle: ob.title,
      onboardBody: ob.body,
      onboardCta: ob.cta,
      onboardOptions: ob.options.map((o, i) => ({
        ...o,
        pick: () => this.setState({ onboardPick: i }),
        style: `display: flex; align-items: center; gap: 14px; border: 1px solid rgba(255,255,255,${s.onboardPick === i ? '0.2' : '0.09'}); background: ${s.onboardPick === i ? 'linear-gradient(150deg, rgba(224,165,95,0.13), rgba(255,255,255,0.05))' : 'rgba(255,255,255,0.03)'}; color: ${s.onboardPick === i ? '#f6f4f0' : 'rgba(236,234,230,0.62)'}; border-radius: 14px; padding: 15px 17px; cursor: pointer; font-family: Archivo, sans-serif; backdrop-filter: blur(16px);`,
        checkStyle: `width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0; border: 1px solid ${s.onboardPick === i ? accent : 'rgba(255,255,255,0.18)'}; background: ${s.onboardPick === i ? accent : 'transparent'}; box-shadow: ${s.onboardPick === i ? 'inset 0 0 0 3px rgba(8,9,12,0.9)' : 'none'};`
      })),
      onboardNext: () => s.onboardStep < 2 ? this.setState({ onboardStep: s.onboardStep + 1 }) : this.setState({ screen: 'story' }),
      onboardArtStyle: `height: 244px; border-radius: 18px; border: 1px solid rgba(255,255,255,0.11); display: flex; align-items: flex-end; padding: 14px; background: linear-gradient(155deg, rgba(224,165,95,0.18), rgba(8,9,12,0.9)), ${STRIPE('rgba(255,255,255,0.06)', 'rgba(255,255,255,0.015)')};`,
      onboardPromises: [
        { t: 'Characters that hold a line', d: 'Behaviour anchors are checked on every draft. They can refuse you, and they will.' },
        { t: 'A face that stays the same', d: 'Upload or generate once; identity persists across avatars, backdrops and scene art.' },
        { t: 'Seasons that remember selectively', d: 'At each season\u2019s end I read it back and ask what mattered — you decide what the next one carries.' },
        { t: 'Private by default', d: 'Nothing is listed, shared or used for training unless you choose to publish it.' }
      ]
    };
  }
}
