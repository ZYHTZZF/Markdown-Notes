import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { safeMarkdown } from './markdown';
import {
  BookOpen,
  Plus,
  Search,
  FileText,
  Trash2,
  Tags,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  Link2,
  ArrowLeft,
  Download,
  Archive,
  RotateCcw,
  Check,
  CloudOff,
  MoreHorizontal,
  X,
  Pencil,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Columns2,
  AlignLeft,
  Eye,
  Bold,
  Heading2,
  List,
  Code2,
  Quote,
  Keyboard,
  ExternalLink,
  Folder,
  Hash,
  Command,
  PanelLeft,
  FileDown,
  PenLine,
} from 'lucide-react';
import { codepoints, key, matchRange, trim } from '../shared/rules';
import type { NoteView, Tag } from '../shared/types';
import './style.css';
import { version as APP_VERSION } from '../../package.json';
import { usePaneLayout, PaneDivider } from './pane-layout';
import { AppearanceSettings, applyAppearance } from './appearance';
import { DEFAULT_APPEARANCE, type AppearanceView } from '../shared/appearance';
import type { LiveEditorHandle } from './live-editor';
const LiveEditor = lazy(() =>
  import('./live-editor').then((module) => ({ default: module.LiveEditor })),
);

const api = window.notesApi;
const date = (s: string) =>
  new Date(s).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
const fullDate = (s: string) => new Date(s).toLocaleString('zh-CN');
const size = (n: number) =>
  n >= 1048576
    ? (n / 1048576).toFixed(1) + ' MiB'
    : n >= 1024
      ? (n / 1024).toFixed(1) + ' KiB'
      : n + ' B';
type Draft = {
  note_id: string;
  revision: number;
  content: string;
  tag_ids: string[];
  sequence: number;
  dirty: boolean;
};
type Modal = { type: string; data?: any };

function ModalBox({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const first = box.current?.querySelector<HTMLElement>('input,button,textarea');
    first?.focus();
    const listen = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Tab') {
        const focusable = [
          ...box.current!.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select,textarea',
          ),
        ];
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          focusable.at(-1)?.focus();
        } else if (!e.shiftKey && at === focusable.length - 1) {
          e.preventDefault();
          focusable[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', listen);
    return () => {
      document.removeEventListener('keydown', listen);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={'modal ' + (wide ? 'wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭对话框" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, key(trim(query)));
  return range ? (
    <>
      {text.slice(0, range[0])}
      <mark>{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  ) : (
    <>{text}</>
  );
}

function App() {
  const [appearance, setAppearance] = useState<AppearanceView>({
    ...DEFAULT_APPEARANCE,
    image_data: null,
  });
  const [pdfBackground, setPdfBackground] = useState(false);
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  useEffect(() => {
    void api
      .call('appearance.get')
      .then(setAppearance)
      .catch(() => {});
  }, []);
  const layout = usePaneLayout();
  const [status, setStatus] = useState<any>(null),
    [allTags, setAllTags] = useState<Tag[]>([]),
    [items, setItems] = useState<any[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [view, setView] = useState<'all' | 'trash'>('all'),
    [query, setQuery] = useState(''),
    [scope, setScope] = useState('all'),
    [filters, setFilters] = useState<string[]>([]),
    [refresh, setRefresh] = useState(0),
    [listState, setListState] = useState('loading');
  const [note, setNote] = useState<NoteView | null>(null),
    [draft, setDraftState] = useState<Draft | null>(null),
    [saveState, setSaveState] = useState('saved'),
    [mode, setMode] = useState<'edit' | 'split' | 'read' | 'live'>('split'),
    [font, setFont] = useState(16),
    [modal, setModal] = useState<Modal | null>(null),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(''),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [links, setLinks] = useState<any>({ outgoing: [], incoming: [] }),
    [linkTab, setLinkTab] = useState('outgoing'),
    [referencesOpen, setReferencesOpen] = useState(false),
    [settingsTab, setSettingsTab] = useState('library'),
    [backups, setBackups] = useState<any[]>([]);
  const draftRef = useRef<Draft | null>(null),
    saveFlight = useRef<Promise<void> | null>(null),
    searchRef = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    queryToken = useRef<string | undefined>(undefined),
    epochRef = useRef<string | null>(null),
    statusRef = useRef<any>(null),
    firstEdit = useRef(0),
    toastTimer = useRef<any>(null);
  const liveEditor = useRef<LiveEditorHandle>(null);
  const referencesButton = useRef<HTMLButtonElement>(null),
    referencesCloseButton = useRef<HTMLButtonElement>(null);
  const closeReferences = useCallback(() => {
    setReferencesOpen(false);
    referencesButton.current?.focus();
  }, []);
  useEffect(() => {
    if (referencesOpen) referencesCloseButton.current?.focus();
  }, [referencesOpen]);
  useEffect(() => {
    if (!referencesOpen || modal) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeReferences();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [referencesOpen, modal, closeReferences]);
  const setDraft = (value: Draft | null) => {
    draftRef.current = value;
    setDraftState(value);
  };
  const notify = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 6500 : 3500);
  }, []);
  const refreshTags = useCallback(async () => {
    try {
      setAllTags(await api.call('tag.list'));
    } catch {}
  }, []);
  const installNote = useCallback((n: NoteView | null) => {
    setNote(n);
    if (n)
      setDraft({
        note_id: n.note_id,
        revision: n.revision,
        content: n.content,
        tag_ids: n.tags.map((t) => t.tag_id),
        sequence: 0,
        dirty: false,
      });
    else {
      setDraft(null);
      setReferencesOpen(false);
    }
    setSaveState('saved');
  }, []);
  const flush = useCallback(async () => {
    if (saveFlight.current) return saveFlight.current;
    const run = (async () => {
      while (draftRef.current?.dirty) {
        const d = { ...draftRef.current, tag_ids: [...draftRef.current.tag_ids] };
        setSaveState('saving');
        try {
          const result = await api.call('note.save', {
            note_id: d.note_id,
            expected_revision: d.revision,
            content: d.content,
            tag_ids: d.tag_ids,
            edit_sequence: d.sequence,
          });
          if (draftRef.current?.note_id === d.note_id) {
            const latest = draftRef.current;
            setDraft({
              ...latest,
              revision: result.note.revision,
              dirty: latest.sequence !== d.sequence,
            });
            setNote(result.note);
            setSaveState(latest.sequence === d.sequence ? 'saved' : 'dirty');
            firstEdit.current = Date.now();
          }
        } catch (e: any) {
          setSaveState('failed');
          throw e;
        }
      }
    })();
    saveFlight.current = run;
    try {
      await run;
    } finally {
      saveFlight.current = null;
    }
  }, []);
  const act = useCallback(
    async (label: string, fn: () => Promise<void>, save = true) => {
      setBusy(label);
      try {
        if (save) await flush();
        await fn();
      } catch (e: any) {
        if (e.code !== 'E_CANCELLED') notify(e.message || '操作未完成', true);
      } finally {
        setBusy('');
      }
    },
    [flush, notify],
  );
  const select = useCallback(
    (id: string) =>
      act('打开笔记', async () => {
        const n = await api.call('note.get', { note_id: id, trash: view === 'trash' });
        installNote(n);
      }),
    [act, view, installNote],
  );
  const create = useCallback(
    () =>
      act('新建笔记', async () => {
        if (!statusRef.current?.epoch) throw new Error('资料库仍在打开，请稍候');
        const result = await api.call('note.create');
        setView('all');
        setQuery('');
        setFilters([]);
        setPage(1);
        installNote(result.note);
        setRefresh((n) => n + 1);
        setTimeout(() => {
          editor.current?.focus();
          liveEditor.current?.focus();
        }, 40);
      }),
    [act, installNote],
  );
  const closeModal = useCallback(() => {
    if (!busy) setModal(null);
  }, [busy]);

  useEffect(() => {
    let alive = true;
    api
      .call('system.status')
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        statusRef.current = s;
        epochRef.current = s.epoch;
        if (s.profile) {
          setMode(
            localStorage.getItem('zhiye.live-mode.v1') === 'true'
              ? 'live'
              : (s.profile.preferences.mode ?? 'split'),
          );
          setFont(s.profile.preferences.font_size ?? 16);
        }
        if (!s.fault) void refreshTags();
      })
      .catch((e) => notify(e.message, true));
    const off = api.onChange((s) => {
      if (!alive) return;
      const changedEpoch = epochRef.current && s.epoch && epochRef.current !== s.epoch;
      epochRef.current = s.epoch || epochRef.current;
      setStatus(s);
      statusRef.current = s;
      if (changedEpoch) {
        installNote(null);
        setQuery('');
        setFilters([]);
        setPage(1);
        void refreshTags();
      }
      if (s.kind === 'commit' || s.kind === 'restore' || s.index?.state === 'ready') {
        queryToken.current = undefined;
        setRefresh((n) => n + 1);
        void refreshTags();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [notify, refreshTags, installNote]);
  useEffect(
    () =>
      api.onClose(async () => {
        try {
          await flush();
          return true;
        } catch {
          return false;
        }
      }),
    [flush],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      if (draftRef.current?.dirty) void flush().catch((e) => notify(e.message, true));
    }, 1000);
    return () => clearTimeout(timer);
  }, [draft?.sequence, flush, notify]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (draftRef.current?.dirty && Date.now() - firstEdit.current >= 5000)
        void flush().catch((e) => notify(e.message, true));
    }, 250);
    return () => clearInterval(timer);
  }, [flush, notify]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush()
          .then(() => notify('已保存'))
          .catch((e) => notify(e.message, true));
      } else if (e.key.toLowerCase() === 'n' && !modal) {
        e.preventDefault();
        void create();
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [create, flush, notify, modal]);
  useEffect(() => {
    if (!status || status.fault) return;
    let disposed = false;
    const timer = setTimeout(
      async () => {
        setListState('loading');
        try {
          const searching = view !== 'trash' && query.trim();
          const data = await api.call(
            searching ? 'search.query' : 'note.list',
            searching
              ? {
                  keyword: query,
                  scope,
                  tag_ids: filters,
                  page,
                  ...(page > 1 && queryToken.current ? { query_token: queryToken.current } : {}),
                }
              : { trash: view === 'trash', tag_ids: view === 'trash' ? [] : filters, page },
          );
          if (disposed) return;
          if (data.query_token) queryToken.current = data.query_token;
          setItems(data.items);
          setTotal(data.total);
          setListState('ready');
        } catch (e: any) {
          if (disposed) return;
          if (e.code === 'E_QUERY_STALE') {
            queryToken.current = undefined;
            setPage(1);
          } else if (e.code === 'E_INDEX_UNAVAILABLE') setListState('index');
          else {
            setListState('error');
            notify(e.message, true);
          }
        }
      },
      query ? 220 : 0,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    query,
    scope,
    filters.join(','),
    page,
    view,
    refresh,
    status?.fault,
    Boolean(status),
    notify,
  ]);
  useEffect(() => {
    setPage(1);
    queryToken.current = undefined;
  }, [query, scope, filters.join(','), view]);
  useEffect(() => {
    if (!note || note.deleted_at || status?.index?.state !== 'ready') {
      setLinks({ outgoing: [], incoming: [] });
      return;
    }
    let alive = true;
    api
      .call('links', { note_id: note.note_id })
      .then((data) => {
        if (alive) setLinks(data);
      })
      .catch(() => {
        if (alive) setLinks({ outgoing: [], incoming: [] });
      });
    return () => {
      alive = false;
    };
  }, [note?.note_id, status?.index?.state, status?.index?.indexed_version]);
  useEffect(() => {
    if (modal?.type === 'settings' && !status?.fault)
      api
        .call('backup.list')
        .then(setBackups)
        .catch(() => {});
  }, [modal?.type, refresh, status?.fault]);

  const content = draft?.content ?? '',
    preview = useMemo(() => safeMarkdown(content), [content]);
  const edit = (value: string) => {
    if (!draftRef.current || note?.deleted_at) return;
    const old = draftRef.current;
    if (!old.dirty) firstEdit.current = Date.now();
    setDraft({ ...old, content: value, sequence: old.sequence + 1, dirty: true });
    setSaveState('dirty');
  };
  const toggleTag = (tag_id: string) => {
    const d = draftRef.current;
    if (!d) return;
    const ids = d.tag_ids.includes(tag_id)
      ? d.tag_ids.filter((id) => id !== tag_id)
      : [...d.tag_ids, tag_id];
    if (ids.length > 20) {
      notify('每篇最多20个标签', true);
      return;
    }
    if (!d.dirty) firstEdit.current = Date.now();
    setDraft({ ...d, tag_ids: ids, sequence: d.sequence + 1, dirty: true });
    setSaveState('dirty');
  };
  const switchView = (next: 'all' | 'trash') =>
    void act('切换视图', async () => {
      if (layout.hidden.list) layout.toggle('list');
      setView(next);
      setFilters([]);
      setQuery('');
      installNote(null);
      setPage(1);
    });
  const changeMode = (next: 'edit' | 'split' | 'read' | 'live') => {
    setMode(next);
    if (next === 'live') {
      localStorage.setItem('zhiye.live-mode.v1', 'true');
      return;
    }
    localStorage.removeItem('zhiye.live-mode.v1');
    void api
      .call('preferences', { preferences: { mode: next } })
      .catch((e) => notify(e.message, true));
  };
  const insert = (a: string, b = '') => {
    if (mode === 'live') {
      liveEditor.current?.insert(a, b);
      return;
    }
    const t = editor.current;
    if (!t) return;
    const start = t.selectionStart,
      end = t.selectionEnd;
    edit(content.slice(0, start) + a + content.slice(start, end) + b + content.slice(end));
    setTimeout(() => {
      t.focus();
      t.setSelectionRange(start + a.length, end + a.length);
    }, 0);
  };
  const jump = (targetKey: string) =>
    void act('打开引用', async () =>
      installNote(await api.call('link.open', { target_key: targetKey })),
    );
  const onPreviewClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    e.preventDefault();
    if (anchor.dataset.note) jump(decodeURIComponent(anchor.dataset.note));
    else if (anchor.getAttribute('href')?.match(/^https?:\/\//))
      void api
        .call('system.openLink', { url: anchor.getAttribute('href') })
        .catch((e) => notify(e.message, true));
  };
  const openSettings = (tab = 'library') => {
    setSettingsTab(tab);
    setModal({ type: 'settings' });
  };
  const backup = () =>
    void act('正在创建完整备份', async () => {
      const b = await api.call('backup.create');
      notify(
        b.registration_warning ? '备份文件已生成，历史登记失败，请保管文件' : '完整备份已创建',
      );
      setRefresh((n) => n + 1);
    });
  const inspect = () =>
    void act(
      '检查备份',
      async () => {
        const data = await api.call('restore.inspect');
        setModal({ type: 'restore', data });
      },
      !status?.fault,
    );
  const removeNote = () =>
    void act('移入回收站', async () => {
      await api.call('trash.move', {
        note_id: note!.note_id,
        expected_revision: draftRef.current!.revision,
      });
      installNote(null);
      setRefresh((n) => n + 1);
      notify('已移入回收站');
    });
  const rename = () => {
    if (!note) return;
    setInput(note.title);
    setModal({ type: 'rename' });
  };
  const renameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void act('检查改名影响', async () => {
      const data = await api.call('note.rename.prepare', {
        note_id: note!.note_id,
        expected_revision: draftRef.current!.revision,
        title: input,
      });
      setModal({ type: 'renameConfirm', data: { ...data, title: input } });
    });
  };
  const tagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = modal?.data;
    void act('保存标签', async () => {
      if (data?.tag_id) await api.call('tag.rename', { tag_id: data.tag_id, name: input });
      else {
        const t = await api.call('tag.create', { name: input });
        if (data?.assign) toggleTag(t.tag_id);
      }
      await refreshTags();
      setModal(null);
      setRefresh((n) => n + 1);
    });
  };
  const restoreTrash = () => {
    setInput(note!.title);
    setModal({ type: 'restoreTrash' });
  };

  return (
    <div
      className={
        'app-shell' +
        (layout.resizing ? ' resizing' : '') +
        (layout.hidden.sidebar ? ' sidebar-hidden' : '')
      }
      style={
        {
          '--sidebar-width': layout.widths.sidebar + 'px',
          '--list-width': layout.widths.list + 'px',
        } as React.CSSProperties
      }
    >
      <header className="topbar" aria-label="窗口工具栏">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={21} strokeWidth={1.7} />
          </div>
          <strong>知页</strong>
          <span>个人知识库</span>
        </div>
        <div className="pane-toggles" aria-label="工作区显示">
          <button
            className={'icon' + (!layout.hidden.sidebar ? ' pane-visible' : '')}
            aria-label={layout.hidden.sidebar ? '展开导航栏' : '隐藏导航栏'}
            title={layout.hidden.sidebar ? '展开导航栏' : '隐藏导航栏'}
            aria-pressed={!layout.hidden.sidebar}
            onClick={() => layout.toggle('sidebar')}
          >
            <PanelLeft size={18} />
          </button>
          <button
            className={'icon' + (!layout.hidden.list ? ' pane-visible' : '')}
            aria-label={layout.hidden.list ? '展开笔记列表' : '隐藏笔记列表'}
            title={layout.hidden.list ? '展开笔记列表' : '隐藏笔记列表'}
            aria-pressed={!layout.hidden.list}
            onClick={() => layout.toggle('list')}
          >
            <Columns2 size={18} />
          </button>
        </div>
        <div className="global-search">
          <Search size={17} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value && layout.hidden.list) layout.toggle('list');
              if (view === 'trash') setView('all');
            }}
            placeholder="搜索你的知识库…"
            aria-label="搜索笔记"
          />
          <kbd>Ctrl K</kbd>
          {query && (
            <button className="icon" aria-label="清空搜索" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <button className="button subtle" onClick={() => openSettings('backup')}>
          <Archive size={16} />
          <span>备份与恢复</span>
        </button>
        <button
          className="new-button"
          onClick={() => void create()}
          disabled={!status || !!busy || !!status?.fault}
        >
          <Plus size={17} />
          新建笔记
        </button>
      </header>
      {!layout.hidden.sidebar && (
        <aside id="navigation-pane" className="sidebar">
          <div className="workspace-label">
            知识空间 <span>本地</span>
          </div>
          <button
            className={'nav ' + (view === 'all' && !filters.length ? 'active' : '')}
            onClick={() => switchView('all')}
          >
            <FileText size={17} />
            全部笔记<span>{status?.stats?.active ?? 0}</span>
          </button>
          <button
            className={'nav ' + (view === 'trash' ? 'active' : '')}
            onClick={() => switchView('trash')}
          >
            <Trash2 size={17} />
            回收站<span>{status?.stats?.trash ?? 0}</span>
          </button>
          <div className="section-label">
            标签分类
            <button
              className="icon"
              title="管理标签"
              aria-label="管理标签"
              onClick={() => setModal({ type: 'tags' })}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="tag-navigation">
            {allTags.map((t) => (
              <button
                key={t.tag_id}
                className={'tag-nav ' + (filters.includes(t.tag_id) ? 'selected' : '')}
                onClick={() => {
                  if (layout.hidden.list) layout.toggle('list');
                  if (view === 'trash') setView('all');
                  setFilters((prev) =>
                    prev.includes(t.tag_id)
                      ? prev.filter((x) => x !== t.tag_id)
                      : [...prev, t.tag_id],
                  );
                }}
              >
                <span className="tag-dot" />
                <span>{t.name}</span>
                {filters.includes(t.tag_id) && <Check size={13} />}
              </button>
            ))}
            {!allTags.length && (
              <p className="sidebar-hint">
                用标签整理不同主题
                <br />
                <button
                  onClick={() => {
                    setInput('');
                    setModal({ type: 'tagEdit' });
                  }}
                >
                  创建第一个标签 <Plus size={12} />
                </button>
              </p>
            )}
          </div>
          {filters.length > 0 && (
            <button className="clear-filter" onClick={() => setFilters([])}>
              清除筛选 · {filters.length}个标签
            </button>
          )}
          <div className="sidebar-bottom">
            <div className="offline">
              <span className="local-dot" />
              <span>本地存储 · 离线可用</span>
              <CloudOff size={14} />
            </div>
            <button className="profile" onClick={() => openSettings()}>
              <span className="avatar">我</span>
              <span>
                <strong>个人知识库</strong>
                <small>只属于你的思考空间</small>
              </span>
              <Settings size={17} />
            </button>
          </div>
        </aside>
      )}
      {!layout.hidden.sidebar && <PaneDivider {...layout.divider('sidebar')} />}
      <main className="main">
        {status?.fault ? (
          <div className="fault-screen">
            <div className="fault-icon">
              <ShieldCheck size={36} />
            </div>
            <p className="eyebrow">数据保护模式</p>
            <h1>先保护资料，再开始恢复</h1>
            <p>{status.fault}</p>
            <div className="protected-path">
              原始材料保留位置
              <br />
              <code>{status.active_path || status.root}</code>
            </div>
            <button className="new-button" onClick={inspect} disabled={!!busy}>
              <RotateCcw size={16} />
              选择完整备份进行恢复
            </button>
            <small>恢复将使用独立资料目录，原始文件与输入备份会保留。</small>
          </div>
        ) : (
          <div className="workspace">
            {!layout.hidden.list && (
              <section id="note-list-pane" className="note-list">
                <div className="list-heading">
                  <div>
                    <h1>
                      {query
                        ? '搜索结果'
                        : view === 'trash'
                          ? '回收站'
                          : filters.length
                            ? '标签筛选'
                            : '全部笔记'}
                    </h1>
                    <p>{total} 篇笔记</p>
                  </div>
                  <button
                    className="icon"
                    title="刷新列表"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                {query && (
                  <div className="scope-tabs">
                    {[
                      ['all', '全部'],
                      ['title', '标题'],
                      ['content', '正文'],
                      ['tag', '标签'],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={scope === value ? 'selected' : ''}
                        onClick={() => setScope(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="list-sort">
                  <span>{query ? '按匹配字段与更新时间' : '最近更新'}</span>
                  <ChevronDown size={13} />
                </div>
                <div className="notes-scroll">
                  {listState === 'index' ? (
                    <div className="list-message">
                      <RefreshCw size={22} />
                      <strong>索引正在更新</strong>
                      <p>正文已保存，搜索就绪后将刷新。</p>
                    </div>
                  ) : items.length ? (
                    items.map((n) => (
                      <button
                        className={'note-card ' + (note?.note_id === n.note_id ? 'selected' : '')}
                        key={n.note_id}
                        onClick={() => void select(n.note_id)}
                      >
                        <div className="note-card-title">
                          <FileText size={15} />
                          <strong>
                            <Highlight text={n.title} query={query} />
                          </strong>
                        </div>
                        <p>
                          <Highlight
                            text={n.snippet?.trim() || '这篇笔记等待你的第一个想法…'}
                            query={query}
                          />
                        </p>
                        <div className="note-card-foot">
                          <time>{date(n.updated_at)}</time>
                          {n.tags?.slice(0, 2).map((t: any) => (
                            <span key={t.tag_id} className="chip small">
                              {t.name}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="list-message">
                      <FileText size={25} />
                      <strong>
                        {listState === 'loading'
                          ? '正在读取…'
                          : query
                            ? '还没有找到匹配内容'
                            : view === 'trash'
                              ? '回收站是空的'
                              : '留一点空间给新想法'}
                      </strong>
                      <p>
                        {query
                          ? '试试更简短的关键词，或调整筛选。'
                          : view === 'trash'
                            ? '删除的笔记会保留在这里。'
                            : '点击新建，写下第一篇笔记。'}
                      </p>
                    </div>
                  )}
                </div>
                <div className="pagination">
                  <span>{total ? `${page} / ${Math.ceil(total / 50)} 页` : '暂无笔记'}</span>
                  <button
                    className="icon"
                    aria-label="上一页"
                    disabled={page <= 1 || listState === 'index'}
                    onClick={() => setPage((n) => n - 1)}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    className="icon"
                    aria-label="下一页"
                    disabled={page * 50 >= total || listState === 'index'}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </section>
            )}
            {!layout.hidden.list && <PaneDivider {...layout.divider('list')} />}
            {note && draft ? (
              <section className="document">
                <div className="document-top">
                  <div className="document-label">
                    <FileText size={14} />
                    {note.deleted_at ? '回收站 / 只读' : 'Markdown 笔记'}
                  </div>
                  <div className="document-actions">
                    {!note.deleted_at ? (
                      <>
                        <button
                          className="icon"
                          title="重命名笔记"
                          aria-label="重命名笔记"
                          onClick={rename}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon"
                          title="导出Markdown"
                          aria-label="导出当前笔记"
                          onClick={() =>
                            void act('导出笔记', async () => {
                              await api.call('export', { note_id: note.note_id });
                              notify('Markdown正文已导出');
                            })
                          }
                        >
                          <Download size={16} />
                        </button>
                        <button
                          className="icon"
                          title="导出PDF"
                          aria-label="导出PDF"
                          disabled={!!busy}
                          onClick={() => {
                            setPdfBackground(false);
                            setModal({ type: 'pdfExport' });
                          }}
                        >
                          <FileDown size={16} />
                        </button>
                        <button
                          className="icon danger-hover"
                          title="移入回收站"
                          aria-label="删除当前笔记"
                          onClick={removeNote}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="button" onClick={restoreTrash}>
                          <RotateCcw size={14} />
                          恢复笔记
                        </button>
                        <button
                          className="button danger"
                          onClick={() =>
                            void act(
                              '永久删除',
                              async () => {
                                await api.call('trash.purge', {
                                  note_id: note.note_id,
                                  expected_revision: note.revision,
                                });
                                installNote(null);
                                setRefresh((n) => n + 1);
                                notify('笔记已永久删除');
                              },
                              false,
                            )
                          }
                        >
                          <Trash2 size={14} />
                          永久删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="document-heading">
                  <h1 title={note.title} onDoubleClick={() => !note.deleted_at && rename()}>
                    {note.title}
                  </h1>
                  <div className="document-meta">
                    <span>更新于 {fullDate(note.updated_at)}</span>
                    <span>·</span>
                    <span>{codepoints(content)} 字符</span>
                    <span>·</span>
                    <span>{size(new TextEncoder().encode(content).length)}</span>
                  </div>
                  <div className="document-tags">
                    {draft.tag_ids
                      .map((id) => allTags.find((t) => t.tag_id === id))
                      .filter(Boolean)
                      .map((t) => (
                        <span key={t!.tag_id} className="chip">
                          <Hash size={11} />
                          {t!.name}
                        </span>
                      ))}
                    {!note.deleted_at && (
                      <button className="add-tag" onClick={() => setModal({ type: 'tagPicker' })}>
                        <Plus size={13} />
                        添加标签
                      </button>
                    )}
                  </div>
                </div>
                {note.deleted_at && (
                  <div className="trash-banner">
                    <Trash2 size={15} />
                    回收站笔记不参与搜索和引用。恢复时会按当前标题重新解析引用，已删除的标签不会复活。
                  </div>
                )}
                <div className="editor-toolbar">
                  <div className="format-tools">
                    {[
                      [Heading2, '标题', '## ', ''],
                      [Bold, '粗体', '**', '**'],
                      [List, '列表', '- ', ''],
                      [Quote, '引用', '> ', ''],
                      [Code2, '代码', '`', '`'],
                      [Link2, '双向引用', '[[', ']]'],
                    ].map(([Icon, label, a, b]: any) => (
                      <button
                        className="icon"
                        key={label}
                        title={label}
                        aria-label={'插入' + label}
                        disabled={!!note.deleted_at || mode === 'read'}
                        onClick={() => insert(a, b)}
                      >
                        <Icon size={16} />
                      </button>
                    ))}
                  </div>
                  <div className="view-tabs">
                    {[
                      ['edit', '写作', AlignLeft],
                      ['live', '即时', PenLine],
                      ['split', '分屏', Columns2],
                      ['read', '阅读', Eye],
                    ].map(([m, label, Icon]: any) => (
                      <button
                        key={m}
                        className={mode === m ? 'selected' : ''}
                        aria-pressed={mode === m}
                        onClick={() => changeMode(m)}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    ref={referencesButton}
                    className={'references-toggle ' + (referencesOpen ? 'selected' : '')}
                    aria-label="查看引用关系"
                    aria-expanded={referencesOpen}
                    aria-controls="reference-drawer"
                    onClick={() => (referencesOpen ? closeReferences() : setReferencesOpen(true))}
                  >
                    <Link2 size={15} />
                    <span>引用</span>
                    <small>
                      {links.outgoing.length} / {links.incoming.length}
                    </small>
                  </button>
                </div>
                <div
                  className={'editor-area ' + mode}
                  style={{ '--editor-font': font + 'px' } as React.CSSProperties}
                >
                  {mode === 'live' && (
                    <>
                      <div className="live-editor-hint">
                        即时编辑 · 输入 ## 空格变成标题 · Ctrl+单击打开引用或链接 ·
                        点击公式／表格修改源码
                      </div>
                      <Suspense fallback={<p className="live-editor-hint">正在打开即时编辑器…</p>}>
                        <LiveEditor
                          key={note.note_id}
                          ref={liveEditor}
                          value={content}
                          readOnly={!!note.deleted_at || !!busy}
                          onChange={edit}
                          onLink={(kind, target) => {
                            if (kind === 'note') jump(target);
                            else
                              void api
                                .call('system.openLink', { url: target })
                                .catch((e) => notify(e.message, true));
                          }}
                        />
                      </Suspense>
                    </>
                  )}
                  {(mode === 'edit' || mode === 'split') && (
                    <div className="source-pane">
                      <div className="pane-label">Markdown 源文</div>
                      <textarea
                        ref={editor}
                        value={content}
                        readOnly={!!note.deleted_at || !!busy}
                        spellCheck={false}
                        aria-label="Markdown编辑器"
                        placeholder="从一个想法开始…\n\n输入 [[笔记名称]]，把知识连接起来。"
                        onChange={(e) => edit(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Tab') {
                            e.preventDefault();
                            insert('  ');
                          }
                        }}
                      />
                    </div>
                  )}
                  {(mode === 'read' || mode === 'split') && (
                    <div className="preview-pane">
                      <div className="pane-label">
                        预览 <span>实时呈现</span>
                      </div>
                      <article
                        className="markdown"
                        onClick={onPreviewClick}
                        dangerouslySetInnerHTML={{
                          __html:
                            preview ||
                            '<p class="preview-placeholder">你的内容将在这里慢慢成形。</p>',
                        }}
                      />
                    </div>
                  )}
                </div>
                {referencesOpen && (
                  <aside
                    id="reference-drawer"
                    className="reference-panel"
                    aria-label="笔记引用关系"
                  >
                    <div className="reference-heading">
                      <div>
                        <h2>知识关联</h2>
                        <p title={note.title}>{note.title}</p>
                      </div>
                      <button
                        ref={referencesCloseButton}
                        className="icon"
                        aria-label="关闭引用面板"
                        onClick={closeReferences}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div className="reference-tabs">
                      <button
                        className={linkTab === 'outgoing' ? 'active' : ''}
                        aria-pressed={linkTab === 'outgoing'}
                        onClick={() => setLinkTab('outgoing')}
                      >
                        <Link2 size={14} />
                        引用目标<span>{links.outgoing.length}</span>
                      </button>
                      <button
                        className={linkTab === 'incoming' ? 'active' : ''}
                        aria-pressed={linkTab === 'incoming'}
                        onClick={() => setLinkTab('incoming')}
                      >
                        <ArrowLeft size={14} />
                        引用来源<span>{links.incoming.length}</span>
                      </button>
                    </div>
                    <div className="reference-content">
                      {note.deleted_at ? (
                        <span className="muted">
                          回收站笔记不参与引用。恢复后将按当前标题重新解析。
                        </span>
                      ) : status?.index?.state !== 'ready' ? (
                        <span className="muted">引用索引更新中，已保存正文不受影响。</span>
                      ) : links[linkTab].length ? (
                        links[linkTab].map((l: any, i: number) => (
                          <button
                            key={i}
                            className={'reference-link ' + (!l.target_id ? 'broken' : '')}
                            onClick={() =>
                              linkTab === 'incoming'
                                ? void act('打开引用来源', async () =>
                                    installNote(
                                      await api.call('note.get', { note_id: l.source_id }),
                                    ),
                                  )
                                : jump(l.target_key)
                            }
                          >
                            <FileText size={13} />
                            <strong>{linkTab === 'incoming' ? l.source_title : l.name}</strong>
                            {l.source_id === l.target_id && <small>当前笔记</small>}
                            {!l.target_id && linkTab === 'outgoing' && <small>目标不存在</small>}
                            <span>{l.occurrences} 处</span>
                            <ArrowUpRight size={12} />
                          </button>
                        ))
                      ) : (
                        <span className="muted">
                          {linkTab === 'incoming'
                            ? '还没有其他笔记引用这里。'
                            : '在正文输入 [[笔记名称]]，建立第一条知识关联。'}
                        </span>
                      )}
                    </div>
                    <p className="reference-footer">目标 / 来源 · 仅统计已保存的内容</p>
                  </aside>
                )}
              </section>
            ) : (
              <section className="empty-document">
                <div className="empty-illustration">
                  <div className="paper back" />
                  <div className="paper front">
                    <BookOpen size={46} strokeWidth={1.2} />
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="spark one">✦</span>
                  <span className="spark two">✧</span>
                </div>
                <p className="eyebrow">YOUR PERSONAL KNOWLEDGE SPACE</p>
                <h1>
                  {!status
                    ? '正在打开知识库'
                    : view === 'trash'
                      ? '每一份记录，都值得被保留'
                      : '给想法一个安静的地方'}
                </h1>
                <p>
                  {view === 'trash'
                    ? '选择一篇笔记查看，或将它恢复到知识库。'
                    : '记录、整理、连接。让今天的思考，成为明天的灵感。'}
                </p>
                {view === 'all' && (
                  <button
                    className="new-button"
                    onClick={() => void create()}
                    disabled={!status || !!busy}
                  >
                    <Plus size={17} />
                    写下一个新想法<kbd>Ctrl N</kbd>
                  </button>
                )}
                <div className="empty-features">
                  <span>
                    <FileText size={15} />
                    Markdown写作
                  </span>
                  <span>
                    <Link2 size={15} />
                    双向知识关联
                  </span>
                  <span>
                    <ShieldCheck size={15} />
                    数据留在本地
                  </span>
                </div>
              </section>
            )}
          </div>
        )}
        <footer className="statusbar">
          <span className={'save-status ' + saveState}>
            {saveState === 'saving' ? (
              <Loader2 size={12} className="spin" />
            ) : saveState === 'failed' ? (
              <AlertTriangle size={12} />
            ) : (
              <CheckCircle2 size={12} />
            )}
            正文：
            {!draft
              ? '未打开笔记'
              : saveState === 'saved'
                ? '已保存'
                : saveState === 'saving'
                  ? '保存中'
                  : saveState === 'failed'
                    ? '保存失败 · 输入已保留'
                    : '未保存'}
          </span>
          <span className="status-divider" />
          <span>
            索引：
            {status?.index?.state === 'ready'
              ? '可用'
              : status?.index?.state === 'rebuilding'
                ? '重建中'
                : status?.index?.state === 'failed'
                  ? '更新失败'
                  : '更新中'}
            {status?.index?.unavailable_ms > 1000 &&
              ` · 已等待${Math.round(status.index.unavailable_ms / 1000)}秒`}
          </span>
          {busy && (
            <span className="task-status">
              <Loader2 size={12} className="spin" />
              {busy}…
            </span>
          )}
          <span className="status-end">
            UTF-8 <span>·</span> Markdown{' '}
            <button onClick={() => openSettings('help')} title="快捷键与帮助">
              <Keyboard size={13} />
            </button>
          </span>
        </footer>
      </main>
      {toast && (
        <div role="status" className={'toast ' + (toast.error ? 'error' : '')}>
          <span>{toast.error ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}</span>
          {toast.text}
          <button className="icon" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <ModalBox
          title={
            {
              rename: '重命名笔记',
              renameConfirm: '确认改名影响',
              restoreTrash: '恢复笔记',
              tagEdit: modal.data?.tag_id ? '修改标签' : '新建标签',
              tags: '管理标签',
              tagPicker: '为笔记添加标签',
              settings: '知识库设置',
              restore: '恢复预检',
              pdfExport: '导出PDF',
            }[modal.type] ?? '设置'
          }
          onClose={closeModal}
          wide={modal.type === 'settings' || modal.type === 'restore'}
        >
          {modal.type === 'rename' && (
            <form onSubmit={renameSubmit}>
              <label className="field-label">笔记标题</label>
              <input
                className="field"
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={200}
              />
              <p className="form-hint">标题须唯一，长度1—100个字符。自引用也会同步更新。</p>
              <div className="modal-actions">
                <button type="button" className="button" onClick={closeModal}>
                  取消
                </button>
                <button className="new-button" disabled={!!busy}>
                  检查影响
                </button>
              </div>
            </form>
          )}
          {modal.type === 'renameConfirm' && (
            <>
              <p className="modal-intro">
                将笔记改名为 <strong>{modal.data.title}</strong>
              </p>
              <div className="info-box">
                <Link2 size={18} />
                <p>
                  {modal.data.message}
                  <br />
                  当前匹配来源：{modal.data.affected} 篇{modal.data.self ? '，包含自引用' : ''}
                  。提交时会检查全部联动容量，超限则整次拒绝。
                </p>
              </div>
              <div className="modal-actions">
                <button className="button" onClick={closeModal}>
                  取消
                </button>
                <button
                  className="new-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act('同步重命名', async () => {
                      const result = await api.call('note.rename', {
                        plan_token: modal.data.plan_token,
                      });
                      installNote(result.note);
                      setModal(null);
                      setRefresh((n) => n + 1);
                      notify('标题与有效引用已同步更新');
                    })
                  }
                >
                  确认重命名
                </button>
              </div>
            </>
          )}
          {modal.type === 'restoreTrash' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  '恢复笔记',
                  async () => {
                    const result = await api.call('trash.restore', {
                      note_id: note!.note_id,
                      expected_revision: note!.revision,
                      title: input,
                    });
                    setView('all');
                    installNote(result.note);
                    setModal(null);
                    setRefresh((n) => n + 1);
                    notify('笔记已恢复，引用按当前标题重新解析');
                  },
                  false,
                );
              }}
            >
              <label className="field-label">恢复后的标题</label>
              <input className="field" value={input} onChange={(e) => setInput(e.target.value)} />
              <div className="info-box">
                <Link2 size={17} />
                <p>
                  正文保持原文。引用会按当前标题重新解析，可能指向同名新笔记或变为失效；已全局删除的标签不会恢复。
                </p>
              </div>
              <div className="modal-actions">
                <button type="button" className="button" onClick={closeModal}>
                  取消
                </button>
                <button className="new-button" disabled={!!busy}>
                  恢复笔记
                </button>
              </div>
            </form>
          )}
          {modal.type === 'tagEdit' && (
            <form onSubmit={tagSubmit}>
              <label className="field-label">标签名称</label>
              <input
                className="field"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="例如：课程笔记、阅读、项目思考"
              />
              <p className="form-hint">1—30个字符；同一篇笔记最多关联20个标签。</p>
              <div className="modal-actions">
                <button type="button" className="button" onClick={closeModal}>
                  取消
                </button>
                <button className="new-button" disabled={!!busy}>
                  保存标签
                </button>
              </div>
            </form>
          )}
          {(modal.type === 'tags' || modal.type === 'tagPicker') && (
            <>
              <div className="tag-manager">
                {allTags.map((t) => (
                  <div className="tag-manager-row" key={t.tag_id}>
                    {modal.type === 'tagPicker' ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={draft?.tag_ids.includes(t.tag_id) ?? false}
                          onChange={() => toggleTag(t.tag_id)}
                        />
                        <span className="tag-dot" />
                        {t.name}
                      </label>
                    ) : (
                      <>
                        <span className="tag-dot" />
                        <span>{t.name}</span>
                        <button
                          className="icon"
                          aria-label={'修改标签' + t.name}
                          onClick={() => {
                            setInput(t.name);
                            setModal({ type: 'tagEdit', data: t });
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon danger-hover"
                          aria-label={'删除标签' + t.name}
                          onClick={() =>
                            void act('删除全局标签', async () => {
                              await api.call('tag.delete', { tag_id: t.tag_id });
                              if (note)
                                installNote(
                                  await api.call('note.get', {
                                    note_id: note.note_id,
                                    trash: !!note.deleted_at,
                                  }),
                                );
                              setFilters((f) => f.filter((id) => id !== t.tag_id));
                              await refreshTags();
                              setRefresh((n) => n + 1);
                              notify('标签及全部关联已移除');
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                {!allTags.length && <p className="muted">还没有标签，新建一个主题开始整理。</p>}
              </div>
              <div className="modal-actions">
                <button
                  className="button"
                  onClick={() => {
                    setInput('');
                    setModal({ type: 'tagEdit', data: { assign: modal.type === 'tagPicker' } });
                  }}
                >
                  <Plus size={14} />
                  新建标签
                </button>
                <button
                  className="new-button"
                  onClick={() => {
                    setModal(null);
                    void flush().catch((e) => notify(e.message, true));
                  }}
                >
                  完成
                </button>
              </div>
            </>
          )}
          {modal.type === 'settings' && (
            <>
              <div className="settings-tabs">
                {[
                  ['library', '资料库'],
                  ['appearance', '外观'],
                  ['backup', '备份与恢复'],
                  ['help', '使用帮助'],
                ].map(([tab, label]) => (
                  <button
                    key={tab}
                    className={settingsTab === tab ? 'active' : ''}
                    onClick={() => setSettingsTab(tab)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {settingsTab === 'library' && (
                <div className="settings-content">
                  <div className="setting-section">
                    <h3>
                      <Folder size={17} />
                      本地资料库
                    </h3>
                    <p className="path-box">{status?.active_path || status?.root}</p>
                    <button className="button" onClick={() => void api.call('system.reveal')}>
                      <FolderOpen size={14} />
                      在文件管理器中查看
                    </button>
                  </div>
                  <div className="stats-grid">
                    <div>
                      <strong>{status?.stats?.notes ?? 0}</strong>
                      <span>篇笔记 / 10,000</span>
                    </div>
                    <div>
                      <strong>{size(status?.stats?.bytes ?? 0)}</strong>
                      <span>正文总量 / 300 MiB</span>
                    </div>
                    <div>
                      <strong>{status?.stats?.links ?? 0}</strong>
                      <span>条有效引用 / 100,000</span>
                    </div>
                  </div>
                  <div className="setting-section">
                    <h3>编辑字号</h3>
                    <div className="font-options">
                      {[14, 16, 18, 20].map((value) => (
                        <button
                          key={value}
                          className={'button ' + (font === value ? 'chosen' : '')}
                          onClick={() => {
                            setFont(value);
                            void api
                              .call('preferences', { preferences: { font_size: value } })
                              .catch((e) => notify(e.message, true));
                          }}
                        >
                          {value}px
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="setting-section row">
                    <div>
                      <h3>搜索与引用索引</h3>
                      <p className="muted">重建期间可继续编辑，搜索和引用查询暂不可用。</p>
                      <small>
                        业务版本 {status?.index?.business_version ?? 0} / 索引版本{' '}
                        {status?.index?.indexed_version ?? '—'} · {status?.index?.phase}
                      </small>
                    </div>
                    <button
                      className="button"
                      disabled={status?.index?.state === 'rebuilding' || !!busy}
                      onClick={() =>
                        void act('启动索引重建', async () => {
                          await api.call('index.rebuild');
                          notify('已启动重建，已保存正文会被保留');
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      重建索引
                    </button>
                  </div>
                  <p className="muted mini">
                    插件和主题扩展属于P2，本基础版本未启用。云同步、移动端、多人协作不在本版范围内。
                  </p>
                </div>
              )}
              {settingsTab === 'appearance' && (
                <AppearanceSettings value={appearance} onChange={setAppearance} notify={notify} />
              )}
              {settingsTab === 'backup' && (
                <div className="settings-content">
                  <div className="backup-callout">
                    <ShieldCheck size={25} />
                    <div>
                      <h3>把重要的知识，留一份完整副本</h3>
                      <p>完整备份保留正文、标签、回收站和显示偏好；Markdown导出用于外部阅读。</p>
                    </div>
                  </div>
                  <div className="backup-buttons">
                    <button className="new-button" onClick={backup} disabled={!!busy}>
                      <Archive size={16} />
                      创建完整备份
                    </button>
                    <button className="button" onClick={inspect} disabled={!!busy}>
                      <RotateCcw size={16} />
                      从备份恢复
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        void act('批量导出', async () => {
                          await api.call('export');
                          notify('全部有效笔记已导出');
                        })
                      }
                      disabled={!!busy}
                    >
                      <Download size={16} />
                      导出全部Markdown
                    </button>
                  </div>
                  <div className="info-box">
                    <AlertTriangle size={17} />
                    <p>
                      备份ZIP不加密，请妥善保管。成功备份不会自动轮换或删除；建议另存一份到独立介质。跨设备迁移需手动复制完整备份后恢复，不支持Markdown文件导入。
                    </p>
                  </div>
                  <h3 className="history-title">
                    本机备份记录 <span>{backups.length}</span>
                  </h3>
                  <div className="backup-history">
                    {backups.length ? (
                      backups.map((b) => (
                        <div className="backup-row" key={b.backup_id}>
                          <Archive size={19} />
                          <div>
                            <strong>
                              {b.backup_type === 'before_restore'
                                ? '恢复前保护备份'
                                : '手动完整备份'}
                            </strong>
                            <span>
                              {fullDate(b.completed_at)} · {b.note_count} 篇 · {size(b.file_size)}
                            </span>
                            <small title={b.file_path}>{b.file_path}</small>
                          </div>
                          <span className={'backup-badge ' + (!b.exists ? 'missing' : '')}>
                            {b.exists ? '文件可访问' : '文件已不可访问'}
                          </span>
                          <button
                            className="icon"
                            title="查看备份位置"
                            onClick={() =>
                              void api.call('system.reveal', { backup_id: b.backup_id })
                            }
                          >
                            <FolderOpen size={16} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="history-empty">还没有备份。现在创建第一份完整副本。</div>
                    )}
                  </div>
                </div>
              )}
              {settingsTab === 'help' && (
                <div className="settings-content help">
                  <h3>一个小而完整的知识整理流程</h3>
                  <p>
                    新建笔记 → Markdown写作 → 添加标签 → 搜索回顾 → 用双向引用连接 → 定期完整备份。
                  </p>
                  <div className="help-shortcuts">
                    <span>
                      新建笔记 <kbd>Ctrl N</kbd>
                    </span>
                    <span>
                      手动保存 <kbd>Ctrl S</kbd>
                    </span>
                    <span>
                      聚焦搜索 <kbd>Ctrl K</kbd>
                    </span>
                  </div>
                  <h3>常用Markdown</h3>
                  <p>
                    工具栏“即时”可在一个编辑区内边写边呈现；输入 ##
                    后接空格创建二级标题，支持列表、引用、粗体、行内代码等。公式与表格点击后显示源码，移开光标后恢复渲染。Ctrl+Z撤销、Ctrl+Y重做；Ctrl+单击打开引用或链接。切换回“分屏”可查看完整Markdown原文。
                  </p>
                  <pre>
                    {
                      '# 一级标题\n## 二级标题\n**粗体**  *斜体*\n- 列表条目\n- [ ] 待办任务\n> 引用文字\n`行内代码`\n[[另一篇笔记的标题]]'
                    }
                  </pre>
                  <p>
                    双向引用按当前笔记标题匹配，区分有效与失效。代码、公式内与转义标记不建立关系。名称中的井号、竖线等按字面匹配。
                  </p>
                  <h3>数学公式与PDF</h3>
                  <pre>
                    {
                      '$E=mc^2$  或  \\(E=mc^2\\)\n\n$$\n\\frac{a}{b}+\\sqrt{x}\n$$\n\n\\[\\int_0^1 x^2\\,dx=\\frac{1}{3}\\]'
                    }
                  </pre>
                  <p>
                    支持常用LaTeX分式、上下标、积分、矩阵和对齐环境；公式内中文建议用 \\text
                    {'{中文}'}
                    。公式语法有误时显示源码提示。代码中的公式标记保持原样，普通金额中的美元符号可写成
                    \\$。
                  </p>
                  <p>
                    点击笔记右上角“导出PDF”可保存当前笔记为A4文档，包含标题、正文和公式。字体离线加载，PDF保留可选择的中文文字；不包含回收站、标签等备份元数据，不能用于恢复资料库。
                  </p>
                  <p>
                    “正文已保存”与“索引可用”分别显示。磁盘写入失败时请保留编辑窗口并重试；不要直接修改内部数据库文件。
                  </p>
                  <p className="muted">知页 {APP_VERSION} · 本地优先 · 首发备份格式1</p>
                </div>
              )}
            </>
          )}
          {modal.type === 'restore' && (
            <>
              <div className="backup-callout">
                <ShieldCheck size={25} />
                <div>
                  <h3>备份检查完成</h3>
                  <p>
                    {modal.data.manifest.note_count} 篇笔记（含回收站） ·{' '}
                    {fullDate(modal.data.manifest.snapshot_at)}
                  </p>
                </div>
              </div>
              <div className="info-box">
                <AlertTriangle size={18} />
                <p>
                  {modal.data.message}
                  <br />
                  恢复会验证全部业务数据与派生索引，再切换资料库。此过程不合并两端内容。
                </p>
              </div>
              <label className="field-label">原始资料位置</label>
              <p className="path-box">{modal.data.original_path}</p>
              <div className="modal-actions">
                <button className="button" onClick={closeModal}>
                  取消
                </button>
                <button
                  className="new-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      '构建并验证恢复资料库',
                      async () => {
                        const data = await api.call('restore.execute', {
                          inspect_token: modal.data.inspect_token,
                        });
                        installNote(null);
                        setStatus(await api.call('system.status'));
                        setModal(null);
                        setRefresh((n) => n + 1);
                        notify('完整资料库已恢复，原始材料与保护副本已保留');
                      },
                      false,
                    )
                  }
                >
                  <RotateCcw size={15} />
                  执行整体恢复
                </button>
              </div>
            </>
          )}
          {modal.type === 'pdfExport' && (
            <>
              <p className="muted">将当前笔记导出为A4 PDF，保留中文与公式字体。</p>
              <label className="pdf-background-choice">
                <input
                  type="checkbox"
                  checked={pdfBackground}
                  onChange={(e) => setPdfBackground(e.target.checked)}
                />
                带背景导出
              </label>
              <p className="muted mini">
                不勾选时使用纯白背景；勾选后使用已保存的工作区背景和强度，正文保留浅色阅读底层。默认外观的背景为白色。
              </p>
              <div className="modal-actions">
                <button className="button" onClick={closeModal}>
                  取消
                </button>
                <button
                  className="new-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act('导出PDF', async () => {
                      await api.call('export.pdf', {
                        note_id: note!.note_id,
                        include_background: pdfBackground,
                      });
                      setModal(null);
                      notify('PDF已导出（含中文与公式字体）');
                    })
                  }
                >
                  导出PDF文件
                </button>
              </div>
            </>
          )}
        </ModalBox>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
