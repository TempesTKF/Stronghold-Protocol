// so-names.mjs — 把离线版运行时的库改成安装器肯解压的名字：node android/tools/so-names.mjs <源目录> <目标目录>
//
// Android 12–15 安装不可调试的 APK 时，只把 lib/<abi>/ 下"以 lib 开头、以 .so 结尾"的文件解到
// nativeLibraryDir（frameworks/base NativeLibraryHelper / androidfw ApkParsing 的 ValidLibraryPathLastSlash；
// Android 16 去掉了这条检查，所以只在 API 36 模拟器上测过时没暴露）。Termux 的库带版本号（libcrypto.so.3、
// libicuuc.so.78、libz.so.1…），在这些系统上不会被解压，node 启动时链接器找不到它们，打印
// CANNOT LINK EXECUTABLE 后以退出码 1 结束——首页就显示「node exited (1)」。
//
// 这里把 lib<名>.so.<版本> 改名为 lib<名><版本>.so（短一个字符），并把各 ELF 里引用旧名的地方——DT_NEEDED、
// DT_SONAME、版本需求表（DT_VERNEED 的 vn_file）——原地改成新名，多出的一个字节补 0。它们都指向 .dynstr
// 里的字符串，只改这些被引用的位置，不做全文件替换。只支持 64 位小端 ELF（arm64-v8a、x86_64）。

import fs from 'node:fs';
import path from 'node:path';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法：node android/tools/so-names.mjs <源目录> <目标目录>');
  process.exit(2);
}

/** lib<名>.so.<版本> → lib<名><版本>.so；本来就是 .so 结尾的原样返回。 */
const renamed = (name) => name.replace(/^(lib.+)\.so\.(\d+)$/, '$1$2.so');

const DT_NEEDED = 1n, DT_STRTAB = 5n, DT_SONAME = 14n, DT_VERNEED = 0x6ffffffen, DT_VERNEEDNUM = 0x6fffffffn;

function patchElf(buf, file) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file}: 不是 ELF`);
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error(`${file}: 只支持 64 位小端 ELF`);
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const loads = [];
  let dynamic = null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const type = buf.readUInt32LE(p);
    const seg = { offset: Number(buf.readBigUInt64LE(p + 8)), vaddr: Number(buf.readBigUInt64LE(p + 16)),
      filesz: Number(buf.readBigUInt64LE(p + 32)) };
    if (type === 1) loads.push(seg);
    if (type === 2) dynamic = seg;
  }
  if (!dynamic) throw new Error(`${file}: 没有 PT_DYNAMIC`);
  const fileOffset = (vaddr) => {
    const seg = loads.find((s) => vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz);
    if (!seg) throw new Error(`${file}: 地址 0x${vaddr.toString(16)} 不在任何 PT_LOAD 里`);
    return vaddr - seg.vaddr + seg.offset;
  };

  const refs = [];   // [种类, .dynstr 内偏移]
  let strtab = null, verneed = null, verneedNum = 0;
  for (let p = dynamic.offset; p < dynamic.offset + dynamic.filesz; p += 16) {
    const tag = buf.readBigInt64LE(p);
    const val = buf.readBigUInt64LE(p + 8);
    if (tag === 0n) break;
    if (tag === DT_NEEDED) refs.push(['NEEDED', Number(val)]);
    else if (tag === DT_SONAME) refs.push(['SONAME', Number(val)]);
    else if (tag === DT_STRTAB) strtab = fileOffset(Number(val));
    else if (tag === DT_VERNEED) verneed = fileOffset(Number(val));
    else if (tag === DT_VERNEEDNUM) verneedNum = Number(val);
  }
  if (strtab === null) throw new Error(`${file}: 没有 DT_STRTAB`);
  // Elf64_Verneed：vn_version u16, vn_cnt u16, vn_file u32, vn_aux u32, vn_next u32
  for (let i = 0, p = verneed; i < verneedNum && p !== null; i++) {
    refs.push(['VERNEED', buf.readUInt32LE(p + 4)]);
    const next = buf.readUInt32LE(p + 12);
    p = next ? p + next : null;
  }

  const readStr = (at) => buf.toString('latin1', at, buf.indexOf(0, at));
  const result = [];
  for (const [kind, off] of refs) {
    const at = strtab + off;
    const old = readStr(at);
    const name = renamed(old);
    if (name !== old) {
      buf.write(name, at, 'latin1');
      buf.fill(0, at + name.length, at + old.length + 1);
    }
    result.push(`${kind}=${name}`);
  }
  return result;
}

fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(src).sort()) {
  const from = path.join(src, name);
  if (!fs.statSync(from).isFile()) continue;
  const buf = fs.readFileSync(from);
  const refs = patchElf(buf, name);
  const out = renamed(name);
  // 改完后每个名字都必须是安装器认的形状
  for (const n of [out, ...refs.map((r) => r.split('=')[1])]) {
    if (n.startsWith('lib') && !n.endsWith('.so')) throw new Error(`${name}: 仍有带版本号的库名 ${n}`);
  }
  fs.writeFileSync(path.join(dst, out), buf, { mode: 0o755 });
  console.log(`    ${out}${out !== name ? ` (<- ${name})` : ''}: ${refs.filter((r) => !r.startsWith('VERNEED')).join(' ')}`);
}
