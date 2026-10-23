import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  slug, escapeHtml, parseFrontmatter, renderMarkdown, renderInline, propsHtml, createResolver, buildTree, searchNotes,
  highlightCode, calloutType, CALLOUT_TYPES, CALLOUT_ICONS, formatBytes, repairMermaid,
} from '../src/notebook/lib.js';

const idx = {
  notes: [
    { path: 'Platform/Launcher and Updates.md', title: 'Launcher and Updates', headings: [{ level: 2, text: 'Download and install', slug: 'download-and-install' }], text: 'The launcher installs Recharge. Beta channel.' },
    { path: 'Recharge.md', title: 'Recharge', headings: [], text: 'Home of everything about the launcher.' },
    { path: 'Amplifier/Saves.md', title: 'Saves and Save Swapping', headings: [{ level: 1, text: 'Saves', slug: 'saves' }], text: 'save files' },
  ],
  assets: { 'pic.png': 'assets/pic.png' },
};
const resolver = createResolver(idx, 'http://hub/api/notebook/recharge/');
const R = (md) => renderMarkdown(md, { resolver }).html;
// real tags only, with their quoted attribute values blanked (escaped text inside a value is harmless)
const tagsOf = (html) => (html.match(/<[a-z][^>]*>/gi) || []).map((t) => t.replace(/"[^"]*"/g, '""'));
const noRaw = (html) => { assert.ok(!/<(script|img src=x|iframe|b>|style|svg onload|a href="javascript)/i.test(html.replace(/<svg class="nb-ico"[\s\S]*?<\/svg>/g, '')), html); };

test('slug matches the publisher', () => {
  assert.equal(slug('Download and install'), 'download-and-install');
  assert.equal(slug('1. The requested list'), '1-the-requested-list');
  assert.equal(slug('What is "this"? (a-b)'), 'what-is-this-a-b');
});

test('frontmatter becomes property chips', () => {
  const { props, body } = parseFrontmatter('---\ntitle: "Hello"\ntags: [a, b]\naliases:\n  - x\n  - y\n---\n# H\n');
  assert.deepEqual(props, [['title', ['Hello']], ['tags', ['a', 'b']], ['aliases', ['x', 'y']]]);
  assert.equal(body, '# H\n');
  assert.match(propsHtml(props), /nb-prop-k">tags<.*nb-prop-v">a</);
  assert.match(renderMarkdown('---\nstatus: draft\n---\ntext').html, /<p>text<\/p>/);
  assert.equal(parseFrontmatter('no front').props.length, 0);
});

test('headings get ids and are collected', () => {
  const r = renderMarkdown('# One\n\n## Two words\n\n## Two words\n');
  assert.match(r.html, /<h1 id="nb-one" data-slug="one">One<\/h1>/);
  assert.match(r.html, /id="nb-two-words"/);
  assert.match(r.html, /id="nb-two-words-1" data-slug="two-words"/);
  assert.deepEqual(r.headings.map((h) => h.slug), ['one', 'two-words', 'two-words']);
});

test('paragraphs, hard breaks, rules', () => {
  assert.equal(R('a\nb'), '<p>a\nb</p>');
  assert.equal(R('a  \nb'), '<p>a<br>b</p>');
  assert.equal(R('a\\\nb'), '<p>a<br>b</p>');
  assert.match(R('x\n\n---\n\ny'), /<p>x<\/p><hr><p>y<\/p>/);
});

test('nested ordered and unordered lists, task lists', () => {
  const h = R('- a\n  - b\n    - c\n- d\n\n1. one\n2. two\n   - sub\n\n3. three');
  assert.match(h, /<ul><li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li><li>d<\/li><\/ul>/);
  assert.match(h, /<ol><li>one<\/li><li>two<ul><li>sub<\/li><\/ul><\/li><li>three<\/li><\/ol>/);
  assert.match(R('5. five\n6. six'), /<ol start="5">/);
  const t = R('- [ ] todo\n- [x] done');
  assert.match(t, /nb-tasks/);
  assert.match(t, /<span class="nb-task" aria-hidden="true"><\/span>todo/);
  assert.match(t, /nb-task done/);
  assert.match(R('- a\n  continued\n- b'), /<li>a\ncontinued<\/li>/);
  assert.match(R('- item\n\n  ```js\n  let x;\n  ```\n'), /<li><p>item<\/p><pre class="nb-code"/);
});

test('GFM tables with alignment, escaped pipes and wikilinks', () => {
  const h = R('| A | B | C |\n|:--|:-:|--:|\n| [[Recharge\\|home]] | `a\\|b` | 3 |\n| x | y |');
  assert.match(h, /<th style="text-align:left">A<\/th><th style="text-align:center">B<\/th><th style="text-align:right">C<\/th>/);
  assert.match(h, /<a class="nb-link" href="#" data-note="Recharge.md">home<\/a>/);
  assert.match(h, /<code>a\|b<\/code>/);
  assert.match(h, /<td style="text-align:right"><\/td>/); // short row padded
  assert.match(R('a | b\n--|--\n1 | 2'), /<table/);
  assert.ok(!/<table/.test(R('just | a pipe')));
});

test('fenced code keeps the language and highlights', () => {
  const h = R('```csharp\npublic class A { // hi\n  string s = "x"; int n = 42; }\n```');
  assert.match(h, /<pre class="nb-code" data-lang="csharp"><code class="lang-csharp">/);
  assert.match(h, /<span class="tk-w">public<\/span>/);
  assert.match(h, /<span class="tk-c">\/\/ hi<\/span>/);
  assert.match(h, /<span class="tk-s">&quot;x&quot;<\/span>/);
  assert.match(h, /<span class="tk-n">42<\/span>/);
  assert.match(highlightCode('const a = `t`; // c', 'js'), /tk-w">const/);
  assert.match(highlightCode('fn main() { let x: u32 = 1; } // c', 'rust'), /tk-w">fn/);
  assert.match(highlightCode('{"a": 1, "b": true}', 'json'), /tk-k">&quot;a&quot;/);
  assert.match(highlightCode('{"a": 1, "b": true}', 'jsonc'), /tk-w">true/);
  assert.equal(highlightCode('<b>', 'text'), '&lt;b&gt;');
  assert.match(R('```\n<script>alert(1)</script>\n```'), /&lt;script&gt;/);
  assert.match(R('~~~\nin\n~~~'), /<pre class="nb-code"><code>in<\/code>/);
  assert.match(R('````\n```\ninner\n```\n````'), /inner/);
  assert.match(R('```c#<img>\nx\n```'), /data-lang="c#img"/);
});

test('inline formatting', () => {
  assert.equal(renderInline('`a<b`'), '<code>a&lt;b</code>');
  assert.equal(renderInline('**b** *i* ~~s~~ ==h== __bb__ _ii_'), '<strong>b</strong> <em>i</em> <del>s</del> <mark class="nb-hl">h</mark> <strong>bb</strong> <em>ii</em>');
  assert.equal(renderInline('***x***'), '<strong><em>x</em></strong>');
  assert.equal(renderInline('snake_case_name and 2*3*4'), 'snake_case_name and 2<em>3</em>4');
  assert.equal(renderInline('a * b * c'), 'a * b * c');
  assert.equal(renderInline('\\*not\\*'), '*not*');
  assert.equal(renderInline('**bold [[Recharge]] x**', { resolver }).includes('<strong>bold <a class="nb-link"'), true);
  assert.equal(renderInline('**two\nlines** and ==a\nb=='), '<strong>two\nlines</strong> and <mark class="nb-hl">a\nb</mark>');
  assert.equal(renderInline('`**x**`'), '<code>**x**</code>');
});

test('callouts: all types, fold markers, nesting, title', () => {
  for (const t of CALLOUT_TYPES) {
    const h = R(`> [!${t}] Title ${t}\n> body`);
    assert.match(h, new RegExp(`<div class="nb-callout" data-type="${t}">`));
    assert.ok(CALLOUT_ICONS[t], t);
    assert.match(h, new RegExp(`Title ${t}`));
  }
  assert.equal(calloutType('summary'), 'abstract');
  assert.equal(calloutType('weird'), 'note');
  assert.match(R('> [!note]\n> body'), /nb-callout-title-text">Note</);
  assert.match(R('> [!tip]- Closed\n> hidden'), /<details class="nb-callout" data-type="tip"><summary/);
  assert.match(R('> [!tip]+ Open\n> shown'), /<details class="nb-callout" data-type="tip" open>/);
  const nested = R('> [!warning] Outer\n> text\n>\n> > [!info] Inner\n> > deep **bold**\n>\n> - list\n>   - sub\n>\n> ```js\n> let a;\n> ```');
  assert.match(nested, /data-type="warning"[\s\S]*data-type="info"[\s\S]*<strong>bold<\/strong>/);
  assert.match(nested, /<ul><li>list<ul><li>sub/);
  assert.match(nested, /<pre class="nb-code"/);
  assert.match(R('> [!note] A\n\n> [!note] B'), /A[\s\S]*B/);
});

test('blockquotes', () => {
  assert.match(R('> quoted\n> more\n\nafter'), /<blockquote><p>quoted\nmore<\/p><\/blockquote><p>after<\/p>/);
  assert.match(R('> not a callout [!note]'), /<blockquote>/);
});

test('wikilinks: plain, alias, heading, same-note, unresolved', () => {
  assert.match(R('[[Recharge]]'), /<a class="nb-link" href="#" data-note="Recharge.md">Recharge<\/a>/);
  assert.match(R('[[Platform/Launcher and Updates]]'), /data-note="Platform\/Launcher and Updates.md"/);
  assert.match(R('[[Launcher and Updates|the launcher]]'), />the launcher<\/a>/);
  assert.match(R('[[launcher and updates]]'), /data-note="Platform\/Launcher and Updates.md"/);
  assert.match(R('[[Recharge#Download and install]]'), /data-anchor="download-and-install">Recharge &gt; Download and install</);
  assert.match(R('[[Recharge#Some Head|alias]]'), /data-anchor="some-head">alias</);
  assert.match(R('[[#Download and install]]'), /<a class="nb-link" href="#download-and-install" data-anchor="download-and-install">Download and install</);
  assert.match(R('[[Recharge#^block]]'), /data-note="Recharge.md">/);
  const missing = R('[[No Such Note]]');
  assert.match(missing, /<span class="nb-link nb-missing"/);
  assert.ok(!/<a /.test(missing));
  assert.match(R('[[Saves and Save Swapping]]'), /Amplifier\/Saves.md/); // by title
  assert.match(R('[[Saves]]'), /Amplifier\/Saves.md/); // by basename
});

test('embeds resolve through assets', () => {
  assert.match(R('![[pic.png]]'), /<img class="nb-img" src="http:\/\/hub\/api\/notebook\/recharge\/assets\/pic.png" alt="pic.png" loading="lazy">/);
  assert.match(R('![[pic.png|300]]'), /width="300"/);
  assert.match(R('![[pic.png|300x100]]'), /width="300" height="100"/);
  assert.match(R('![[PIC.PNG|a caption]]'), /alt="a caption"/);
  assert.match(R('![[gone.png]]'), /nb-missing/);
  assert.match(R('![[Recharge]]'), /data-note="Recharge.md"/);
});

test('markdown links: external, internal, anchors, unsafe', () => {
  const ext = R('[site](https://example.com/a?b=1&c=2)');
  assert.match(ext, /<a class="nb-ext" href="https:\/\/example.com\/a\?b=1&amp;c=2" data-ext-url="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.match(R('<https://x.org/p>'), /nb-ext/);
  assert.match(R('see https://x.org/p. ok'), /href="https:\/\/x.org\/p"[^>]*>https:\/\/x.org\/p<\/a>\. ok/);
  assert.match(R('[n](Recharge.md)'), /data-note="Recharge.md">n</);
  assert.match(R('[n](Platform/Launcher%20and%20Updates.md#Download%20and%20install)'), /data-note="Platform\/Launcher and Updates.md" data-anchor="download-and-install"/);
  assert.match(R('[n](<Platform/Launcher and Updates.md>)'), /data-note="Platform/);
  assert.match(R('[h](#My-Head)'), /href="#my-head"/);
  assert.match(R('[gone](Nope.md)'), /nb-missing/);
  assert.match(R('[f](https://e.com/a_(b))'), /a_\(b\)/);
  assert.match(R('![alt](pic.png)'), /<img class="nb-img" src="http:\/\/hub/);
  assert.ok(!/<img/.test(R('![x](https://tracker.example/p.png)')));
});

test('footnotes', () => {
  const h = R('Text[^1] and more[^note].\n\n[^1]: First *note*.\n[^note]: Second\n    continued.');
  assert.match(h, /<sup class="nb-fnref"><a href="#" data-fn="1">1<\/a><\/sup>/);
  assert.match(h, /data-fn="note">2</);
  assert.match(h, /<li id="nb-fn-1">First <em>note<\/em>\./);
  assert.match(h, /Second continued\./);
  assert.equal(R('x[^nope]'), '<p>x[^nope]</p>');
});

test('mermaid source is kept as text, <br> only there', () => {
  const h = R('```mermaid\nflowchart LR\n  A["a<br>b"] --> B\n```');
  assert.match(h, /<div class="nb-mermaid"><pre class="nb-mermaid-src">flowchart LR\n  A\[&quot;a&lt;br&gt;b&quot;\] --&gt; B<\/pre><\/div>/);
  assert.match(R('text a<br>b'), /&lt;br&gt;/);
  assert.ok(!/<br>/.test(R('text a<br>b')));
});

test('mermaid repair turns ; and escaped quotes into entities', () => {
  assert.equal(repairMermaid('A->>B: "a; b"\nB->>A: \\"q\\"'), 'A->>B: "a#59; b"\nB->>A: #quot;q#quot;');
  assert.equal(repairMermaid('graph LR\nA-->B;\n'), 'graph LR\nA-->B;\n');
});

test('escaping and XSS attempts', () => {
  const evil = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="javascript:alert(1)"></iframe>', '<svg onload=alert(1)>',
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '![x](javascript:alert(1))',
    '[[<img src=x onerror=alert(1)>]]', '[[a|<script>alert(1)</script>]]', '![[<img src=x onerror=alert(1)>.png]]',
    '`<script>`', '**<b>x</b>**', '> [!note] <script>alert(1)</script>\n> <b>x</b>', '# <img src=x onerror=alert(1)>',
    '| <script>alert(1)</script> |\n|---|\n| <b>x</b> |', '---\nk: <script>alert(1)</script>\n---\nbody', '[^1]: <script>alert(1)</script>\n\nx[^1]',
    '<a href="javascript:alert(1)">x</a>', '<style>body{display:none}</style>', '"><script>alert(1)</script>', '[a"onmouseover="alert(1)](https://e.com/"onmouseover="alert(1))',
    '<https://e.com/"onmouseover="alert(1)>', 'https://e.com/"onmouseover="alert(1)',
  ];
  for (const e of evil) {
    const r = renderMarkdown(e, { resolver });
    const html = r.html + propsHtml(r.props);
    noRaw(html);
    assert.ok(!tagsOf(html).some((t) => /\son\w+\s*=/i.test(t)), e + ' => ' + html);
    assert.ok(!/href="javascript:/i.test(html), e);
  }
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('index helpers: tree, search, bytes', () => {
  const t = buildTree(idx.notes, 'Recharge');
  assert.equal(t.notes[0].title, 'Recharge');
  assert.deepEqual(t.folders.map((f) => f.name), ['Amplifier', 'Platform']);
  const r = searchNotes(idx.notes, 'launcher');
  assert.equal(r[0].note.title, 'Launcher and Updates'); // title beats text
  assert.match(r[0].titleHtml, /<mark>Launcher<\/mark> and Updates/);
  assert.match(r[1].snippetHtml, /<mark>launcher<\/mark>/);
  assert.match(searchNotes(idx.notes, 'download')[0].snippetHtml, /nb-snip-head/); // heading hit
  assert.equal(searchNotes(idx.notes, 'zzzz').length, 0);
  assert.equal(searchNotes(idx.notes, '   ').length, 0);
  assert.equal(searchNotes(idx.notes, 'launcher beta').length, 1); // every term must match
  assert.ok(!/<script/.test(searchNotes([{ path: 'a.md', title: '<script>', headings: [], text: '<script>x' }], 'script')[0].titleHtml));
  assert.equal(formatBytes(3068800), '2.9 MB');
  assert.equal(formatBytes(100), '1 KB');
});

// ---- every note of both real vaults
const BUILD = '/run/media/oliver/Drive/.notebook-build/notebook';
const VAULTS = { recharge: '/run/media/oliver/Drive/Scripts/recharge/recharge-vault', igtap: '/run/media/oliver/Drive/Scripts/igtap-vault' };
function loadVault(id) {
  const ip = path.join(BUILD, id, 'index.json');
  if (fs.existsSync(ip)) {
    const index = JSON.parse(fs.readFileSync(ip, 'utf8'));
    return { index, read: (n) => fs.readFileSync(path.join(BUILD, id, 'notes', n.path), 'utf8'), source: 'bundle' };
  }
  const root = VAULTS[id];
  if (!fs.existsSync(root)) return null;
  const notes = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) notes.push({ path: path.relative(root, p), title: e.name.replace(/\.md$/, ''), headings: [], text: '' }); } };
  walk(root);
  return { index: { notes, assets: {} }, read: (n) => fs.readFileSync(path.join(root, n.path), 'utf8'), source: 'folder' };
}

for (const id of ['recharge', 'igtap']) {
  test(`renders every note of the ${id} vault`, (t) => {
    const v = loadVault(id);
    if (!v) { t.skip('vault not available'); return; }
    const res = createResolver(v.index, '');
    let unresolved = 0, mermaid = 0, callouts = 0;
    const missing = new Map();
    for (const n of v.index.notes) {
      const md = v.read(n);
      const r = renderMarkdown(md, { resolver: res });
      assert.ok(r.html.length > 0 || md.trim() === '', n.path);
      noRaw(r.html);
      assert.ok(!tagsOf(r.html).some((t) => /\son\w+\s*=/i.test(t)), n.path);
      const m = r.html.match(/nb-link nb-missing" title="No note called &quot;([^&]*)/g) || [];
      unresolved += m.length;
      for (const x of m) missing.set(x.replace(/^.*&quot;/, ''), (missing.get(x.replace(/^.*&quot;/, '')) || 0) + 1);
      mermaid += (r.html.match(/class="nb-mermaid"/g) || []).length;
      callouts += (r.html.match(/class="nb-callout"|<details class="nb-callout"/g) || []).length;
      assert.ok(!/\[\[|\]\]/.test(r.html.replace(/<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, '')), `leftover wikilink syntax in ${n.path}`);
    }
    console.log(`# ${id} (${v.source}): ${v.index.notes.length} notes rendered, ${unresolved} unresolved wikilinks, ${mermaid} mermaid blocks, ${callouts} callouts` + (missing.size ? '; missing: ' + [...missing].slice(0, 8).map(([k, c]) => `${k} x${c}`).join(', ') : ''));
  });
}

test('emphasis and highlights span line breaks inside a paragraph and a callout', () => {
  const para = 'a ==Same UI, different\ncode path== b **bold\nacross** c';
  const h = renderMarkdown(para, {}); const html = typeof h === 'string' ? h : h.html;
  assert.match(html, /<mark class="nb-hl">Same UI, different\ncode path<\/mark>/);
  assert.match(html, /<strong>bold\nacross<\/strong>/);
  const c = renderMarkdown('> [!abstract] T\n> x ==one\n> two== y', {}); const ch = typeof c === 'string' ? c : c.html;
  assert.match(ch, /<mark class="nb-hl">one\ntwo<\/mark>/);
  const hb = renderMarkdown('line one  \nline two\\\nline three', {}); const hh = typeof hb === 'string' ? hb : hb.html;
  assert.match(hh, /line one<br>line two<br>line three/);
});
