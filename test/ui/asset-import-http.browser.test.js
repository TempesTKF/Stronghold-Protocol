// SP_E2E=1 CHROME_PATH=<browser> node --test test/ui/asset-import-http.browser.test.js
// The mapped .test hostname is genuinely insecure; localhost would grant secure-context APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { startServer } from '../../server/index.js';
import { hash16 } from '../../server/http/assetIndex.js';
import { crc32 } from '../../public/js/assetPack.js';
import { CHROME, hasChrome, ROOT } from '../e2e/client.mjs';

function storedZip(files) {
  const parts = [], directory = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const label = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + label.length + bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint32(14, crc32(bytes), true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, label.length, true);
    local.set(label, 30);
    local.set(bytes, 30 + label.length);
    const central = new Uint8Array(46 + label.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc32(bytes), true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, label.length, true);
    cv.setUint32(42, offset, true);
    central.set(label, 46);
    parts.push(local);
    directory.push(central);
    offset += local.length;
  }
  const centralSize = directory.reduce((size, part) => size + part.length, 0);
  const tail = new Uint8Array(22);
  const view = new DataView(tail.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + centralSize + tail.length);
  let pos = 0;
  for (const part of [...parts, ...directory, tail]) { zip.set(part, pos); pos += part.length; }
  return zip;
}

function validPng() {
  const chunk = (type, body) => {
    const data = Buffer.concat([Buffer.from(type), body]);
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    data.copy(out, 4);
    out.writeUInt32BE(crc32(data), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6; // RGBA, 8 bits per channel
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function validWav() {
  const data = Buffer.alloc(64, 128);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

test('real HTTP import serves persisted art through app loaders without a service worker', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
}, async (t) => {
  const png = validPng();
  const json = Buffer.from('{"source":"imported"}');
  const audio = validWav();
  const wrong = Buffer.from('wrong bytes');
  const expected = Buffer.from('right bytes');
  const absent = Buffer.from('server-only');
  const files = [
    { rel: 'assets/http/import.png', bytes: png },
    { rel: 'assets/http/import.json', bytes: json },
    { rel: 'assets/audio/http/import.wav', bytes: audio },
  ];
  const fontRel = 'fonts/bender-regular.woff2';
  const hasFont = fs.existsSync(path.join(ROOT, 'public', fontRel));
  if (hasFont) files.push({ rel: fontRel, bytes: fs.readFileSync(path.join(ROOT, 'public', fontRel)) });
  const urls = Object.fromEntries(files.map(({ rel, bytes }) => {
    const [prefix, ...rest] = rel.split('/');
    return [rel, `/${prefix}/~${hash16(bytes)}/${rest.join('/')}`];
  }));
  const badUrl = `/assets/~${hash16(expected)}/http/rejected.bin`;
  const absentUrl = `/assets/~${hash16(absent)}/http/server-only.bin`;
  const mediaUrl = `/media/~${hash16(audio)}/http/import`;
  const served = new Map(files.map(({ rel, bytes }) => [urls[rel], bytes]));
  served.set(mediaUrl, audio);
  served.set(badUrl, expected);
  served.set(absentUrl, absent);

  // Optional real Pixi Spine fixture from the local extracted art pack. Source-only
  // checkouts lack public/assets; all other assertions remain independent of it.
  const spineBase = 'assets/spine/enemy/enemy_1200_msfjin/enemy_1200_msfjin';
  const members = ['skel', 'atlas', 'png'].map((ext) => ({ rel: `${spineBase}.${ext}`, ext }));
  const hasSpine = members.every(({ rel }) => fs.existsSync(path.join(ROOT, 'public', rel)));
  let spineEntry = null;
  if (hasSpine) {
    const spineFiles = members.map(({ rel }) => ({ rel, bytes: fs.readFileSync(path.join(ROOT, 'public', rel)) }));
    const groupHash = hash16(spineFiles.map(({ bytes }) => hash16(bytes)).join('\n'));
    spineEntry = Object.fromEntries(members.map(({ rel, ext }) => [ext, `/${rel.replace(/^assets\//, `assets/~${groupHash}/`)}`]));
    for (const member of spineFiles) {
      files.push(member);
      served.set(spineEntry[member.rel.split('.').at(-1)], member.bytes);
    }
  }

  const manifest = {
    files: [...Object.values(urls), badUrl, absentUrl],
    ...(spineEntry ? { chars: { httpProbe: { skel: spineEntry.skel, atlas: spineEntry.atlas, textures: [spineEntry.png] } } } : {}),
  };
  const requests = new Map();
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
  const normal = server.server.listeners('request')[0];
  server.server.removeAllListeners('request');
  server.server.on('request', (request, response) => {
    const url = request.url.split('?')[0];
    requests.set(url, (requests.get(url) || 0) + 1);
    if (url === '/data/assets.json' || url === '/data/local-assets.json' || url === '/data/local-fx.json') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(url === '/data/assets.json' ? manifest : { groups: {} }));
    } else if (served.has(url)) {
      response.writeHead(200, { 'Content-Type': url.endsWith('.png') ? 'image/png' : url.endsWith('.json') ? 'application/json'
        : url === mediaUrl || url.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(served.get(url));
    } else normal.call(server.server, request, response);
  });
  t.after(() => server.close());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-http-import-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const zipPath = path.join(tmp, 'http-import.zip');
  fs.writeFileSync(zipPath, storedZip([
    ...files.map(({ rel, bytes }) => ({ name: `pack/public/${rel}`, bytes })),
    { name: 'pack/public/assets/http/rejected.bin', bytes: wrong },
  ]));

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP import-http.test 127.0.0.1'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = `http://import-http.test:${server.server.address().port}`;
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="asset-import"]');
  const capabilities = await page.evaluate(() => ({
    secure: isSecureContext, serviceWorker: !!navigator.serviceWorker,
    subtle: !!crypto.subtle, caches: !!globalThis.caches, indexedDB: !!globalThis.indexedDB,
  }));
  assert.deepEqual(capabilities, { secure: false, serviceWorker: false, subtle: false, caches: false, indexedDB: true });
  assert.equal(await page.$eval('[data-testid="asset-import"]', (node) => node.textContent.trim()), '导入素材包');
  await page.click('[data-testid="asset-import"]');
  await page.waitForSelector('[data-testid="asset-import-zip-input"]');
  await (await page.$('[data-testid="asset-import-zip-input"]')).uploadFile(zipPath);
  await page.waitForFunction(async () => ['complete', 'partial', 'error'].includes((await import('/js/assetPack.js')).assetImport.get().phase), { timeout: 25000 });
  const importState = await page.evaluate(async () => (await import('/js/assetPack.js')).assetImport.get());
  assert.equal(importState.phase, 'partial', JSON.stringify(importState));
  assert.equal(importState.accepted, files.length);
  assert.equal(importState.rejected, 1);
  for (const url of [...Object.values(urls), mediaUrl, ...(spineEntry ? Object.values(spineEntry) : [])]) {
    assert.equal(requests.get(url) || 0, 0, `${url} was imported without requesting its bytes`);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="asset-import"]');
  await page.click('[data-testid="asset-import"]');
  await page.waitForSelector('[data-testid="asset-import-stored"]');
  assert.equal(await page.$eval('[data-testid="asset-import-stored"]', el => el.textContent),
    `已导入 ${files.length} 个素材文件。`, 'persisted count is visible on HTTP without a storage estimate');
  await page.keyboard.press('Escape');
  const importedPaths = await page.evaluate(async () => [...await (await import('/js/assetCache.js')).listImportedPaths()]);
  for (const url of [...Object.values(urls), mediaUrl, ...(spineEntry ? Object.values(spineEntry) : [])]) {
    assert.ok(importedPaths.includes(url), `${url} persisted in the import index`);
  }
  assert.ok(!importedPaths.includes(badUrl));
  const beforeReads = new Map(requests);
  const result = await page.evaluate(async ({ image, data, media, originalAudio, font, spine, absent, bad }) => {
    const { assetFetch, loadAssetImage } = await import('/js/importedAssets.js');
    const { html } = await import('/js/ui/components.js');
    const { render } = await import('/vendor/preact.module.js');
    const imageResponse = await assetFetch(image);
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
    const jsonValue = await (await assetFetch(data)).json();
    const audioResponse = await assetFetch(media);
    const audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
    const { AudioManager } = await import('/js/audio.js');
    const manager = new AudioManager();
    manager.ctx = new AudioContext();
    const decoded = await manager._buffer(originalAudio);
    const audioDecoded = decoded ? { length: decoded.length, channels: decoded.numberOfChannels } : null;
    await manager.ctx.close();
    const loadedImage = await loadAssetImage(image);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    render(html`<div><img data-http-image src=${image} /><div data-http-background style=${{ backgroundImage: `url("${image}")` }}></div></div>`, mount);
    await new Promise((resolve, reject) => {
      const until = Date.now() + 5000;
      const check = () => {
        const img = mount.querySelector('[data-http-image]');
        const bg = mount.querySelector('[data-http-background]');
        if (img?.complete && img.naturalWidth > 0 && bg?.style.backgroundImage.includes('blob:')) resolve();
        else if (Date.now() > until) reject(new Error('DOM imported image did not load'));
        else setTimeout(check, 20);
      };
      check();
    });
    const dom = { image: mount.querySelector('img').currentSrc.startsWith('blob:'),
      background: mount.querySelector('[data-http-background]').style.backgroundImage.includes('blob:') };
    render(null, mount); mount.remove();
    const { ensurePixi } = await import('/js/render/app/pixi.js');
    const PIXI = await ensurePixi();
    const texture = await PIXI.Assets.load(image);
    const pixi = { width: texture.width, height: texture.height };
    let fontLoaded = null;
    if (font) {
      const { installAssetFonts } = await import('/js/assetFonts.js');
      await installAssetFonts({ fonts: { faces: { probe: { family: 'SP HTTP Probe', woff2: font } } } });
      fontLoaded = [...document.fonts].some((face) => face.family === 'SP HTTP Probe' && face.status === 'loaded');
    }
    let spineResult = null;
    if (spine) {
      const { loadSpineData } = await import('/js/assets.js');
      const skeleton = await loadSpineData(spine);
      spineResult = { animations: skeleton.animations.length, bones: skeleton.bones.length };
    }
    const absentText = await (await assetFetch(absent)).text();
    const badText = await (await assetFetch(bad)).text();
    return { imageLength: imageBytes.length, jsonValue, audioLength: audioBytes.length,
      audioType: audioResponse.headers.get('content-type'), audioDecoded,
      loadedImage: !!loadedImage, dom, pixi, fontLoaded, spineResult, absentText, badText };
  }, { image: urls['assets/http/import.png'], data: urls['assets/http/import.json'], media: mediaUrl,
    originalAudio: urls['assets/audio/http/import.wav'], font: urls[fontRel], spine: spineEntry,
    absent: absentUrl, bad: badUrl });
  const { audioDecoded, ...loaded } = result;
  assert.ok(audioDecoded?.length >= 64 && audioDecoded.channels === 1, 'AudioManager decoded imported WAV');
  assert.deepEqual(loaded, {
    imageLength: png.length, jsonValue: { source: 'imported' }, audioLength: audio.length,
    audioType: 'audio/wav',
    loadedImage: true, dom: { image: true, background: true },
    pixi: { width: 1, height: 1 }, fontLoaded: hasFont ? true : null,
    spineResult: spineEntry ? result.spineResult : null,
    absentText: 'server-only', badText: 'right bytes',
  });
  if (spineEntry) assert.ok(result.spineResult.animations > 0 && result.spineResult.bones > 0);
  for (const url of [...Object.values(urls), mediaUrl, ...(spineEntry ? Object.values(spineEntry) : [])]) {
    assert.equal(requests.get(url) || 0, beforeReads.get(url) || 0, `${url} read locally after reload`);
  }

  assert.equal(await page.$('[data-testid="asset-download"]'), null, 'bulk download is not exposed');
  assert.ok((requests.get(absentUrl) || 0) > 0, 'unimported art reaches server');
  assert.ok((requests.get('/data/assets.json') || 0) > 0, 'manifest stays on network');
  assert.ok((requests.get('/js/assetPack.js') || 0) > 0, 'code stays on network');

  const legacy = await browser.newPage();
  await legacy.setCacheEnabled(false);
  await legacy.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined });
  });
  await legacy.goto(origin, { waitUntil: 'domcontentloaded' });
  const beforeLegacy = new Map(requests);
  const legacyLoaded = await legacy.evaluate(async ({ image, spine }) => {
    const { ensurePixi } = await import('/js/render/app/pixi.js');
    const PIXI = await ensurePixi();
    const texture = await PIXI.Assets.load(image);
    let animations = null;
    if (spine) {
      const { loadSpineData } = await import('/js/assets.js');
      animations = (await loadSpineData(spine)).animations.length;
    }
    return { bitmapApi: typeof createImageBitmap, width: texture.width, height: texture.height, animations };
  }, { image: urls['assets/http/import.png'], spine: spineEntry });
  assert.deepEqual(legacyLoaded, {
    bitmapApi: 'undefined', width: 1, height: 1, animations: spineEntry ? result.spineResult.animations : null,
  });
  for (const url of [urls['assets/http/import.png'], ...(spineEntry ? Object.values(spineEntry) : [])]) {
    assert.equal(requests.get(url) || 0, beforeLegacy.get(url) || 0, `legacy Pixi loaded ${url} locally`);
  }

  await page.evaluate(async () => (await import('/js/assetCache.js')).clearImportedAssets());
  const fallback = await page.evaluate(async (url) => (await (await import('/js/importedAssets.js')).assetFetch(url)).arrayBuffer().then((body) => body.byteLength), urls['assets/http/import.png']);
  assert.equal(fallback, png.length);
  assert.ok((requests.get(urls['assets/http/import.png']) || 0) > 0, 'cleared image falls back to the server');
  assert.deepEqual(errors, []);
});
