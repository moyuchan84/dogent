import { useEffect, useRef, useState } from 'react';
import { docOfSkill, searchSkills, type Skill } from '@/src/core';

/**
 * 스킬 고르기. 좁은 패널에서 드롭다운 대신, 현재 선택을 한 줄로 보여 주고 누르면 검색 가능한 목록이 펼쳐진다.
 * 목록은 떠 있지 않고 그 자리에서 펼쳐져 패널 가장자리에 잘리지 않는다.
 * 같은 값을 가진 숨은 <select id="skill">이 곁에 있어 접근성 도구와 자동 시험이 그대로 쓴다.
 */
export function SkillPicker(props: {
  skills: Skill[];
  value: string;
  freeId: string;
  disabled?: boolean;
  /** 이름 옆에 붙일 표시 ('초안', '공유'). 없으면 붙이지 않는다 */
  tagOf: (id: string) => string;
  onPick: (id: string) => void;
}) {
  const { skills, value, freeId, disabled, tagOf, onPick } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) search.current?.focus();
    else setQuery('');
  }, [open]);
  // 실행이 시작되면 접는다
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  // 바깥을 누르면 접는다
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const current = skills.find((s) => s.id === value);
  const list = query.trim() ? searchSkills(skills, docOfSkill, query).map((h) => h.item) : skills;
  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
  };

  return (
    <div className="picker" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        id="skill-picker"
        className="picker-current"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="pc-main">
          <b>{current ? current.name : '자유 요청'}</b>
          {current && <span className={`risk ${current.risk}`}>{current.risk}</span>}
          {current && tagOf(current.id) && <span className="tag">{tagOf(current.id)}</span>}
        </span>
        <span className="pc-sub">{current ? current.description : '스킬 없이 지금 화면에서 요청한 일을 합니다'}</span>
        <span className="chevron" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="picker-pop">
          {skills.length > 6 && (
            <input
              ref={search}
              type="search"
              className="picker-search"
              value={query}
              placeholder="스킬 찾기"
              aria-label="스킬 찾기"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <ul role="listbox" aria-label="스킬">
            {!query.trim() && (
              <li>
                <button type="button" role="option" aria-selected={value === freeId} className="opt" data-skill-option={freeId} onClick={() => pick(freeId)}>
                  <span className="pc-main">
                    <b>자유 요청</b>
                  </span>
                  <span className="pc-sub">스킬 없이 지금 화면에서 요청한 일을 합니다</span>
                </button>
              </li>
            )}
            {list.map((s) => (
              <li key={s.id}>
                <button type="button" role="option" aria-selected={value === s.id} className="opt" data-skill-option={s.id} onClick={() => pick(s.id)}>
                  <span className="pc-main">
                    <b>{s.name}</b>
                    <span className={`risk ${s.risk}`}>{s.risk}</span>
                    {tagOf(s.id) && <span className="tag">{tagOf(s.id)}</span>}
                  </span>
                  <span className="pc-sub">{s.description}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="picker-empty">맞는 스킬이 없습니다</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
