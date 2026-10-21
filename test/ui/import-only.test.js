import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../../server/index.js';

test('title only offers local import and removed bulk-download modules return 404', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, admin: false, studio: false, assetIndex: false });
  t.after(() => srv.close());
  const title = await (await fetch(srv.url + '/js/screens/title.js')).text();
  assert.match(title, /<\$\{AssetImportButton\}/);
  assert.doesNotMatch(title, /AssetDownloadButton|assetDownload\.js/);
  for (const url of ['/js/assetDownload.js', '/js/ui/assetDownload.js']) {
    assert.equal((await fetch(srv.url + url)).status, 404, url);
  }
  for (const url of ['/js/assetPack.js', '/js/ui/assetImport.js', '/js/importedAssets.js', '/data/assets.json', '/sw.js']) {
    assert.equal((await fetch(srv.url + url)).status, 200, url);
  }
  assert.match(fs.readFileSync('public/css/screens/title.css', 'utf8'), /\.title-assets\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
