module.exports = function MedalAuto(mod) {
  const ITEM_ID = 221359;
  const BUY_COUNT = 18;
  const MAX_DECOMP = 18;
  const COST = 15;
  const STORE_TYPE = 20;
  const DECOMP_TYPE = 90;
  const STORE_VALUE = 2130002;
  const STORE_DATA = Buffer.from([82, 128, 32, 0]);
  const FULL_MSG = '@3135';
  const SIG_MODE = 'copy';
  const SEND_DELAY = 0;
  const SETTLE_MS = 120;
  const STEP_TIMEOUT = 4000;

  mod.game.initialize('inventory');

  const ADD_OPCODE = mod.dispatch.protocolMap.name.get('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT');

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let running = false;
  let sending = false;
  let credits = Infinity;
  let cycles = 0;
  let storeContract = 0;
  let decContract = 0;
  let lastBasket = null;
  let decompFull = false;
  let decAccepted = 0;

  const stamps = new Map();
  const tpl = { add: null, commit: null };

  const items = () => mod.game.inventory.findAll(ITEM_ID);

  mod.hook('C_MEDAL_STORE_BUY_ADD_BASKET', 'raw', (code, data, fromServer, fake) => {
    if (fake || sending) return;
    tpl.add = Buffer.from(data);
    stamps.set(data.readUInt16LE(2), { counter: data.readUInt32LE(4), sig: data.readUInt32LE(8) });
  });

  mod.hook('C_MEDAL_STORE_COMMIT', 'raw', (code, data, fromServer, fake) => {
    if (fake || sending) return;
    tpl.commit = Buffer.from(data);
    stamps.set(data.readUInt16LE(2), { counter: data.readUInt32LE(4), sig: data.readUInt32LE(8) });
  });

  mod.hook('S_MEDAL_STORE_BASKET', '*', e => { lastBasket = e; });
  mod.hook('S_SYSTEM_MESSAGE', '*', e => { if (e.message === FULL_MSG) decompFull = true; });
  mod.hook('S_RP_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 'raw', (code, data) => {
    if (data[4] === 1) decAccepted++;
  });
  mod.hook('S_LOAD_TOPO', '*', () => { running = false; });

  const check = () => { if (!running) throw new Error('arrete'); };

  const stamp = b => {
    const op = b.readUInt16LE(2);
    const s = stamps.get(op) || { counter: 0, sig: 0 };
    stamps.set(op, s);
    s.counter = (s.counter + 1) >>> 0;
    b.writeUInt32LE(s.counter, 4);
    b.writeUInt32LE(SIG_MODE === 'zero' ? 0 : s.sig, 8);
  };

  const inject = b => {
    sending = true;
    try { mod.toServer(b); } finally { sending = false; }
  };

  const sendStore = (template) => {
    const b = Buffer.from(template);
    stamp(b);
    b.writeUInt32LE(storeContract, 20);
    inject(b);
  };

  const sendDecAdd = dbid => {
    const b = Buffer.allocUnsafe(32);
    b.writeUInt16LE(32, 0);
    b.writeUInt16LE(ADD_OPCODE, 2);
    b.writeUInt32LE(0, 4);
    b.writeUInt32LE(0, 8);
    b.writeUInt32LE(decContract, 12);
    b.writeBigUInt64LE(BigInt(dbid), 16);
    b.writeUInt32LE(ITEM_ID, 24);
    b.writeUInt32LE(1, 28);
    inject(b);
  };

  const waitDef = (name, pred, timeout = STEP_TIMEOUT) => new Promise((resolve, reject) => {
    const h = mod.hook(name, '*', e => {
      if (pred && !pred(e)) return;
      clearTimeout(t);
      mod.unhook(h);
      resolve(e);
    });
    const t = setTimeout(() => { mod.unhook(h); reject(new Error('timeout ' + name)); }, timeout);
  });

  const waitRaw = (name, timeout = STEP_TIMEOUT) => new Promise((resolve, reject) => {
    const h = mod.hook(name, 'raw', (code, data) => {
      clearTimeout(t);
      mod.unhook(h);
      resolve(Buffer.from(data));
    });
    const t = setTimeout(() => { mod.unhook(h); reject(new Error('timeout ' + name)); }, timeout);
  });

  async function openContract(type, value, data) {
    const p = waitDef('S_REQUEST_CONTRACT', e => e.type === type);
    mod.toServer('C_REQUEST_CONTRACT', '*', { type, target: 0n, value, name: '', data });
    return (await p).id;
  }

  const cancelContract = (type, id) => {
    mod.toServer('C_CANCEL_CONTRACT', '*', { type, id });
  };

  async function settle(reader, target) {
    const end = Date.now() + STEP_TIMEOUT;
    let last = -1;
    let stableAt = 0;
    for (;;) {
      check();
      const n = reader();
      if (n >= target) return n;
      const now = Date.now();
      if (n !== last) { last = n; stableAt = now; }
      else if (now - stableAt >= SETTLE_MS) return n;
      if (now >= end) return n;
      await sleep(20);
    }
  }

  async function waitInventory(min) {
    const end = Date.now() + STEP_TIMEOUT;
    while (Date.now() < end) {
      check();
      if (items().length >= min) return;
      await sleep(40);
    }
    throw new Error('inventaire non mis a jour apres achat');
  }

  async function burst(count, send) {
    for (let i = 0; i < count; i++) {
      check();
      send();
      if (SEND_DELAY) await sleep(SEND_DELAY);
    }
  }

  async function buy() {
    const before = items().length;
    lastBasket = null;
    storeContract = await openContract(STORE_TYPE, STORE_VALUE, STORE_DATA);
    await burst(BUY_COUNT, () => sendStore(tpl.add));
    await settle(() => (lastBasket ? lastBasket.basket.length : 0), BUY_COUNT);
    const bought = lastBasket ? lastBasket.basket.length : 0;
    if (lastBasket) credits = lastBasket.credits - lastBasket.cost;
    if (!bought) return 0;
    sendStore(tpl.commit);
    await waitInventory(before + bought);
    cancelContract(STORE_TYPE, storeContract);
    storeContract = 0;
    return bought;
  }

  async function decompose() {
    const dbids = items().slice(0, MAX_DECOMP).map(i => i.dbid);
    if (!dbids.length) return 0;
    decompFull = false;
    decAccepted = 0;
    decContract = await openContract(DECOMP_TYPE, 0, Buffer.alloc(0));
    await burst(dbids.length, (() => { let i = 0; return () => sendDecAdd(dbids[i++]); })());
    const added = await settle(() => decAccepted, dbids.length);
    if (!added) { cancelContract(DECOMP_TYPE, decContract); decContract = 0; return 0; }
    const done = waitRaw('S_RP_COMMIT_DECOMPOSITION_CONTRACT', 6000);
    mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', '*', { contract: decContract });
    await done;
    cancelContract(DECOMP_TYPE, decContract);
    decContract = 0;
    return added;
  }

  async function cycle() {
    if (credits < COST) throw new Error('plus assez de medailles');
    const bought = await buy();
    if (!bought) throw new Error('aucun achat (medailles epuisees ?)');
    const added = await decompose();
    cycles++;
    mod.log('cycle ' + cycles + ' : ' + bought + ' achetes, ' + added + ' demantales, medailles restantes ' + credits);
  }

  async function loop() {
    if (!tpl.add || !tpl.commit) {
      mod.log('Gabarits manquants : achete puis valide 1 fois au shop a medailles pour amorcer, puis relance /medal');
      return;
    }
    running = true;
    cycles = 0;
    credits = Infinity;
    try {
      while (running) await cycle();
    } catch (e) {
      mod.log('Stop : ' + e.message);
    } finally {
      if (storeContract) cancelContract(STORE_TYPE, storeContract);
      if (decContract) cancelContract(DECOMP_TYPE, decContract);
      storeContract = 0;
      decContract = 0;
      running = false;
    }
  }

  mod.command.add('medal', a => {
    if (a === 'stop') { running = false; mod.log('Arret demande'); }
    else if (a === 'status') {
      const miss = [!tpl.add && 'add', !tpl.commit && 'commit'].filter(Boolean);
      mod.log('running=' + running + ' cycles=' + cycles + ' medailles=' + credits + ' gabarits_manquants=' + (miss.join(',') || 'aucun'));
    } else if (!running) loop();
    else mod.log('deja en cours (/medal stop pour arreter)');
  });

  this.destructor = () => { running = false; };
};
