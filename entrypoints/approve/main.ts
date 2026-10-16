import { browser } from 'wxt/browser';
import type { ApprovalRequest } from '@/src/core/types';
import '../sidepanel/style.css';

/**
 * 외부 클라이언트(MCP)가 저장·상신 버튼을 누르려 할 때 확장이 띄우는 승인 창.
 * 화면에서 다시 읽은 현재 값을 보여 주고, 승인해야만 백그라운드가 버튼을 누른다. 창을 닫으면 승인하지 않은 것이다.
 */
const id = Number(new URLSearchParams(location.search).get('id'));
const root = document.getElementById('root')!;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

async function decide(ok: boolean) {
  await browser.runtime.sendMessage({ dogentApproval: 'decide', id, ok });
  window.close();
}

async function show() {
  const request = (await browser.runtime.sendMessage({ dogentApproval: 'get', id })) as ApprovalRequest | null;
  if (!request) {
    root.append(el('section', { className: 'card' }, el('h2', {}, '승인할 요청이 없습니다'), el('p', { className: 'hint' }, '이미 처리되었거나 시간이 지났습니다. 이 창을 닫으세요.')));
    return;
  }
  const fields = el('dl');
  for (const f of request.fields) fields.append(el('div', {}, el('dt', {}, f.name), el('dd', {}, f.value || '(비어 있음)')));
  // 표에 채운 값이 있으면 앞부분을 보여 준다 (Dogent 클라이언트가 스킬을 실행할 때).
  const tables = request.tables.map((t) =>
    el(
      'div',
      { className: 'approval-table' },
      el('p', {}, el('b', {}, t.name), ` · ${t.rowCount}행`),
      el(
        'div',
        { className: 'tablewrap' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ...t.columns.map((c) => el('th', {}, c)))),
          el('tbody', {}, ...t.preview.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c))))),
        ),
      ),
    ),
  );
  const approve = el('button', { id: 'approve', textContent: `승인하고 ${request.button}` });
  const decline = el('button', { id: 'decline', className: 'secondary', textContent: '취소' });
  approve.onclick = () => void decide(true);
  decline.onclick = () => void decide(false);
  root.append(
    el('header', {}, el('h1', {}, el('img', { className: 'logo', src: '/icon/dogent.svg', width: 22, height: 22, alt: '' }), 'Dogent')),
    el(
      'div',
      { className: 'approval', id: 'approval' },
      el('b', {}, `"${request.button}" 전에 확인해 주세요`),
      el('p', { className: 'hint' }, `${request.skill} · ${request.url}`),
      el('p', { className: 'hint' }, '화면에서 다시 읽은 현재 값입니다. 승인하면 실제로 제출됩니다.'),
      fields,
      ...tables,
      el('div', { className: 'row' }, decline, approve),
    ),
  );
  approve.focus();
}

void show();
