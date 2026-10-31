import { parseMarkdown, type Block, type Inline } from './markdown';
import type { Dataset } from './types';

/**
 * 인터랙티브 HTML 보고서. 파일 하나에 글·표·차트를 다 담는다 (외부 스크립트·글꼴을 부르지 않아 사내망·오프라인에서도 열린다).
 * - 본문은 마크다운을 HTML로 바꾼다. HTML 태그는 해석하지 않고 글자로 둔다.
 * - 표는 검색, 머리글을 눌러 정렬, CSV 내려받기가 된다.
 * - 차트는 막대·꺾은선. 값은 데이터셋에서 그대로 가져온다 (모델이 숫자를 옮겨 적지 않는다).
 * 데이터는 <script type="application/json">에 넣고 화면에는 textContent로만 그려, 표 값에 든 태그가 실행되지 않는다.
 */

export type ChartSpec = { dataset: string; type: 'bar' | 'line'; label: string; values: string[]; title?: string };

export type HtmlReport = {
  title: string;
  /** 마크다운 본문 */
  content: string;
  datasets: Dataset[];
  charts: ChartSpec[];
  /** 만든 시각 (보고서 머리에 적는다) */
  created?: Date;
};

/** 보고서 하나에 넣는 표의 최대 행 수. 넘으면 앞부분만 넣고 그렇다고 적는다 */
export const HTML_ROWS_MAX = 5000;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return esc(n.text);
        case 'strong':
          return `<strong>${inlineHtml(n.children)}</strong>`;
        case 'em':
          return `<em>${inlineHtml(n.children)}</em>`;
        case 'code':
          return `<code>${esc(n.text)}</code>`;
        case 'link':
          return `<a href="${esc(n.href)}" target="_blank" rel="noreferrer noopener">${inlineHtml(n.children)}</a>`;
      }
    })
    .join('');
}

function blocksHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading': {
          // 보고서 제목이 h1이라 본문 제목은 h2부터
          const level = Math.min(6, b.level + 1);
          return `<h${level}>${inlineHtml(b.children)}</h${level}>`;
        }
        case 'paragraph':
          return `<p>${b.lines.map(inlineHtml).join('<br>')}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
          const items = b.items
            .map((it) => {
              const box = it.checked === undefined ? '' : `<input type="checkbox" disabled${it.checked ? ' checked' : ''}> `;
              return `<li>${box}${inlineHtml(it.children)}${it.sub ? blocksHtml(it.sub) : ''}</li>`;
            })
            .join('');
          return `<${tag}${start}>${items}</${tag}>`;
        }
        case 'table': {
          const al = (i: number) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '');
          const head = b.head.map((c, i) => `<th${al(i)}>${inlineHtml(c)}</th>`).join('');
          const rows = b.rows.map((r) => `<tr>${r.map((c, i) => `<td${al(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`).join('');
          return `<div class="scroll"><table class="md"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        case 'quote':
          return `<blockquote>${blocksHtml(b.children)}</blockquote>`;
        case 'code':
          return `<pre><code>${esc(b.text)}</code></pre>`;
        case 'hr':
          return '<hr>';
      }
    })
    .join('\n');
}

export function markdownToHtml(src: string): string {
  return blocksHtml(parseMarkdown(src));
}

/** 차트·표가 가리키는 데이터셋과 열이 있는지 본다. 문제가 있으면 모델에 돌려줄 문장을, 없으면 null */
export function checkReport(datasets: Dataset[], charts: ChartSpec[]): string | null {
  for (const c of charts) {
    const ds = datasets.find((d) => d.name === c.dataset);
    if (!ds) return `차트의 데이터셋 "${c.dataset}"을 datasets에 넣으세요`;
    for (const col of [c.label, ...c.values]) {
      if (!ds.columns.includes(col)) return `차트의 열 "${col}"이 "${ds.name}"에 없습니다. 컬럼: ${JSON.stringify(ds.columns)}`;
    }
  }
  return null;
}

export function buildHtmlReport(r: HtmlReport): string {
  const created = r.created ?? new Date();
  const data = {
    datasets: r.datasets.map((d) => ({
      name: d.name,
      columns: d.columns,
      rows: d.rows.slice(0, HTML_ROWS_MAX),
      total: d.rows.length,
    })),
    charts: r.charts,
  };
  // </script>로 블록이 끝나지 않게 <를 이스케이프한다
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const stamp = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Dogent">
<title>${esc(r.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><h1>${esc(r.title)}</h1><p class="meta">Dogent · ${stamp}</p></header>
<article class="content">
${markdownToHtml(r.content)}
</article>
<div id="charts"></div>
<div id="tables"></div>
</main>
<script type="application/json" id="dogent-data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--accent:#2f6fde;--accent2:#e0782f;--head:#f0f0ec;--hl:#fff3b0}
@media (prefers-color-scheme:dark){:root{--bg:#18181a;--card:#222225;--fg:#ececee;--muted:#9b9ba1;--line:#36363a;--accent:#6b9cff;--accent2:#ff9d5c;--head:#2b2b2f;--hl:#5a4a00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
header h1{margin:0;font-size:26px}
.meta{margin:4px 0 20px;color:var(--muted);font-size:13px}
.content,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-bottom:16px}
.content:empty{display:none}
h2,h3,h4{margin:1.2em 0 .4em}
.content>:first-child{margin-top:0}
a{color:var(--accent)}
code{background:var(--head);padding:1px 4px;border-radius:4px;font-size:.92em}
pre{background:var(--head);padding:10px;border-radius:6px;overflow:auto}
blockquote{margin:0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
.scroll{overflow:auto;max-height:70vh}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;white-space:nowrap}
th{background:var(--head);position:sticky;top:0}
table.data th{cursor:pointer;user-select:none}
table.data th[data-dir=asc]::after{content:" ▲";color:var(--accent)}
table.data th[data-dir=desc]::after{content:" ▼";color:var(--accent)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--head)}
mark{background:var(--hl);color:inherit}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.bar h2{margin:0;font-size:18px;flex:1}
.count{color:var(--muted);font-size:13px}
input[type=search]{padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:200px}
button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--accent)}
svg text{fill:var(--fg);font-size:12px}
svg .axis{stroke:var(--line)}
svg .tip{fill:var(--muted)}
.legend{display:flex;gap:12px;font-size:13px;color:var(--muted);margin-top:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
@media print{body{background:#fff}input,button{display:none}.scroll{max-height:none}}
`;

// 보고서 안에서 도는 스크립트. 외부 라이브러리 없이 표 정렬·검색·CSV와 SVG 차트를 그린다.
const SCRIPT = `
(function(){
var data=JSON.parse(document.getElementById('dogent-data').textContent);
var COLORS=['var(--accent)','var(--accent2)','#3aa776','#a35bd6','#d6455b','#2aa3b8'];
function el(tag,attrs,text){var e=document.createElement(tag);if(attrs)for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e}
function svg(tag,attrs,text){var e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e}
function num(v){if(typeof v==='number')return v;var s=String(v).replace(/[,\\s%]/g,'');return s!==''&&isFinite(s)?Number(s):NaN}
function fmt(n){return Math.abs(n)>=1000?n.toLocaleString('ko-KR'):String(Math.round(n*100)/100)}
function csv(ds,rows){var q=function(v){v=String(v);return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  var text='\\ufeff'+[ds.columns.map(q).join(',')].concat(rows.map(function(r){return r.map(q).join(',')})).join('\\r\\n');
  var a=el('a',{href:URL.createObjectURL(new Blob([text],{type:'text/csv'})),download:ds.name+'.csv'});document.body.appendChild(a);a.click();a.remove()}
function highlight(td,text,q){td.textContent='';if(!q){td.textContent=text;return}
  var lo=text.toLowerCase(),i=0,j;while((j=lo.indexOf(q,i))>=0){td.appendChild(document.createTextNode(text.slice(i,j)));td.appendChild(el('mark',null,text.slice(j,j+q.length)));i=j+q.length}
  td.appendChild(document.createTextNode(text.slice(i)))}
data.datasets.forEach(function(ds){
  var card=el('section',{'class':'card'});var bar=el('div',{'class':'bar'});
  bar.appendChild(el('h2',null,ds.name));var count=el('span',{'class':'count'});bar.appendChild(count);
  var search=el('input',{type:'search',placeholder:'표에서 찾기'});bar.appendChild(search);
  var dl=el('button',null,'CSV 내려받기');bar.appendChild(dl);card.appendChild(bar);
  var numeric=ds.columns.map(function(_,c){var seen=0,ok=0;ds.rows.forEach(function(r){if(r[c]!==''&&r[c]!=null){seen++;if(!isNaN(num(r[c])))ok++}});return seen>0&&ok===seen});
  var table=el('table',{'class':'data'}),thead=el('thead'),hr=el('tr'),tbody=el('tbody');
  var sortCol=-1,dir=1,shown=ds.rows;
  ds.columns.forEach(function(name,c){var th=el('th',{title:'눌러서 정렬'},name);th.onclick=function(){
    if(sortCol===c)dir=-dir;else{sortCol=c;dir=1}
    hr.querySelectorAll('th').forEach(function(t){t.removeAttribute('data-dir')});th.setAttribute('data-dir',dir>0?'asc':'desc');render()};hr.appendChild(th)});
  thead.appendChild(hr);table.appendChild(thead);table.appendChild(tbody);
  var wrap=el('div',{'class':'scroll'});wrap.appendChild(table);card.appendChild(wrap);
  function render(){var q=search.value.trim().toLowerCase();
    shown=ds.rows.filter(function(r){return !q||r.some(function(v){return String(v).toLowerCase().indexOf(q)>=0})});
    if(sortCol>=0){var c=sortCol;shown=shown.slice().sort(function(a,b){
      if(numeric[c]){var x=num(a[c]),y=num(b[c]);return ((isNaN(x)?-Infinity:x)-(isNaN(y)?-Infinity:y))*dir}
      return String(a[c]).localeCompare(String(b[c]),'ko',{numeric:true})*dir})}
    tbody.textContent='';shown.forEach(function(r){var tr=el('tr');ds.columns.forEach(function(_,c){var v=r[c]==null?'':String(r[c]);
      var td=el('td',numeric[c]?{'class':'num'}:null);highlight(td,v,q);tr.appendChild(td)});tbody.appendChild(tr)});
    count.textContent=(q?shown.length+' / ':'')+ds.rows.length+'행'+(ds.total>ds.rows.length?' (전체 '+ds.total+'행 중 앞부분)':'')}
  search.oninput=render;dl.onclick=function(){csv(ds,shown)};render();
  document.getElementById('tables').appendChild(card)});
data.charts.forEach(function(ch){
  var ds=data.datasets.filter(function(d){return d.name===ch.dataset})[0];if(!ds)return;
  var li=ds.columns.indexOf(ch.label),vi=ch.values.map(function(v){return ds.columns.indexOf(v)});
  var rows=ds.rows.slice(0,ch.type==='bar'?40:500);
  var card=el('section',{'class':'card'});card.appendChild(el('h2',{style:'margin:0 0 10px;font-size:18px'},ch.title||(ch.values.join(', ')+' — '+ch.label)));
  var max=0,min=0;rows.forEach(function(r){vi.forEach(function(i){var n=num(r[i]);if(!isNaN(n)){max=Math.max(max,n);min=Math.min(min,n)}})});
  var span=(max-min)||1,W=1000,s;
  if(ch.type==='bar'){
    var rowH=Math.max(18,8+12*vi.length),left=160,H=rows.length*rowH+10;
    s=svg('svg',{viewBox:'0 0 '+W+' '+H,width:'100%',role:'img'});
    var zero=left+(0-min)/span*(W-left-90);
    rows.forEach(function(r,k){var y=k*rowH+4,label=String(r[li]);
      s.appendChild(svg('text',{x:left-8,y:y+rowH/2+2,'text-anchor':'end'},label.length>18?label.slice(0,17)+'…':label));
      var h=(rowH-6)/vi.length;
      vi.forEach(function(i,j){var n=num(r[i]);if(isNaN(n))return;var x=left+(Math.min(n,0)-min)/span*(W-left-90),w=Math.abs(n)/span*(W-left-90);
        var b=svg('rect',{x:x,y:y+j*h,width:Math.max(1,w),height:h-1,rx:2,fill:COLORS[j%COLORS.length]});b.appendChild(svg('title',{},label+' · '+ch.values[j]+': '+fmt(n)));s.appendChild(b);
        s.appendChild(svg('text',{x:x+w+4,y:y+j*h+h/2+4,'class':'tip'},fmt(n)))})});
    s.appendChild(svg('line',{x1:zero,x2:zero,y1:0,y2:H,'class':'axis'}));
  }else{
    var H=320,pl=60,pb=40,pt=10,pr=20,iw=W-pl-pr,ih=H-pt-pb;s=svg('svg',{viewBox:'0 0 '+W+' '+H,width:'100%',role:'img'});
    var X=function(k){return pl+(rows.length>1?k/(rows.length-1):0.5)*iw},Y=function(n){return pt+(1-(n-min)/span)*ih};
    for(var g=0;g<=4;g++){var v=min+span*g/4;s.appendChild(svg('line',{x1:pl,x2:W-pr,y1:Y(v),y2:Y(v),'class':'axis'}));s.appendChild(svg('text',{x:pl-6,y:Y(v)+4,'text-anchor':'end','class':'tip'},fmt(v)))}
    var step=Math.max(1,Math.ceil(rows.length/10));rows.forEach(function(r,k){if(k%step===0)s.appendChild(svg('text',{x:X(k),y:H-pb+18,'text-anchor':'middle','class':'tip'},String(r[li]).slice(0,12)))});
    vi.forEach(function(i,j){var pts=[];rows.forEach(function(r,k){var n=num(r[i]);if(!isNaN(n))pts.push([X(k),Y(n),r,n])});
      s.appendChild(svg('polyline',{points:pts.map(function(p){return p[0]+','+p[1]}).join(' '),fill:'none',stroke:COLORS[j%COLORS.length],'stroke-width':2}));
      pts.forEach(function(p){var c=svg('circle',{cx:p[0],cy:p[1],r:3.5,fill:COLORS[j%COLORS.length]});c.appendChild(svg('title',{},String(p[2][li])+' · '+ch.values[j]+': '+fmt(p[3])));s.appendChild(c)})});
  }
  card.appendChild(s);
  if(vi.length>1){var lg=el('div',{'class':'legend'});ch.values.forEach(function(v,j){var sp=el('span');var i=el('i');i.style.background=COLORS[j%COLORS.length];sp.appendChild(i);sp.appendChild(document.createTextNode(v));lg.appendChild(sp)});card.appendChild(lg)}
  if(ds.rows.length>rows.length)card.appendChild(el('p',{'class':'count'},'앞의 '+rows.length+'행만 그렸습니다'));
  document.getElementById('charts').appendChild(card)});
})();
`;
