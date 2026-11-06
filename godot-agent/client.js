/**
 * Client half of @local/dsh-godot: a movable floating run/pause panel.
 *
 * It contributes two slot entries from this one module:
 *  - `conversation.session.header.utilities` gets an invisible bridge that records
 *    the Session id of the page's open conversation (the root-scoped overlay has
 *    no session prop of its own).
 *  - `shell.overlay` gets the visible panel: a small card the user can drag
 *    anywhere over the app (position persisted in localStorage, double-click
 *    resets it), with run/pause toggle, stop, status dot and the running project.
 *
 * It talks to the package's own Host half over two loopback HTTP routes:
 *   GET  /dsh-godot/state?sessionId=…
 *   POST /dsh-godot/control { action: start|pause|resume|toggle|stop, sessionId }
 *
 * No JSX/TypeScript here: the browser loads this file as-is and provides React.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-godot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-godot';
    const POSITION_KEY = 'dsh-godot:float-position';
    const PANEL_WIDTH = 244;
    const PANEL_HEIGHT = 48;
    const EDGE = 8;
    /** Background refresh cadence; Session switches refresh immediately instead. */
    const POLL_INTERVAL_MS = 1000;

    const DICTIONARIES = {
      en: {
        run: 'Run game',
        pause: 'Pause game',
        resume: 'Resume game',
        stop: 'Stop game',
        running: 'Running',
        paused: 'Paused',
        idle: 'Not running',
        busy: 'Working…',
        failed: 'Godot control failed',
        groupLabel: 'Godot game controls',
        moveHint: 'Drag to move · double-click to reset position',
      },
      zh: {
        run: '运行游戏',
        pause: '暂停游戏',
        resume: '继续游戏',
        stop: '停止游戏',
        running: '运行中',
        paused: '已暂停',
        idle: '未运行',
        busy: '处理中…',
        failed: 'Godot 控制失败',
        groupLabel: 'Godot 游戏控制',
        moveHint: '拖动移动 · 双击复位位置',
      },
    };

    const FALLBACK = DICTIONARIES.en;

    /* ---------------------------------------------------------------- session */
    /* The panel is root-scoped, so a tiny store carries the open Session id and
     * notifies the panel the instant the user switches conversations — waiting
     * for the next poll made switching feel slow. */

    /** Session id of the conversation the page currently shows; set by the bridge entry. */
    let activeSessionId = null;
    /** Refresh callbacks waiting for a Session change. */
    const sessionListeners = new Set();

    function setActiveSessionId(next) {
      const normalized = typeof next === 'string' && next.length > 0 ? next : null;
      if (normalized === activeSessionId) return;
      activeSessionId = normalized;
      for (const listener of [...sessionListeners]) {
        try {
          listener();
        } catch {
          /* a listener must not break the others */
        }
      }
    }

    /** Subscribe to Session switches; returns the unsubscriber. */
    function onActiveSessionChange(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    }

    function readStoredPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          return { left: parsed.left, top: parsed.top };
        }
      } catch {
        /* storage can be unavailable; fall through to the default */
      }
      return null;
    }

    function storePosition(position) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch {
        /* storage unavailable: the panel still drags, position just won't persist */
      }
    }

    function viewport() {
      if (typeof window === 'undefined') return { width: 1280, height: 800 };
      return {
        width: Number.isFinite(window.innerWidth) ? window.innerWidth : 1280,
        height: Number.isFinite(window.innerHeight) ? window.innerHeight : 800,
      };
    }

    function clampPosition(position) {
      const { width, height } = viewport();
      return {
        left: Math.min(Math.max(position.left, EDGE), Math.max(EDGE, width - PANEL_WIDTH - EDGE)),
        top: Math.min(Math.max(position.top, EDGE), Math.max(EDGE, height - PANEL_HEIGHT - EDGE)),
      };
    }

    function defaultPosition() {
      const { width } = viewport();
      // Top-right, below the session header; clear of the composer at the bottom.
      return clampPosition({ left: width - PANEL_WIDTH - 24, top: 72 });
    }

    /**
     * Register the package dictionaries on the Client locale service and return
     * a translate function. The service is reached through `ctx.get` so the
     * plugin still mounts when it is absent, and falls back to English.
     */
    function createTranslator(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      if (locale && typeof locale.bind === 'function') {
        if (typeof locale.register === 'function') {
          for (const [localeId, dict] of Object.entries(DICTIONARIES)) {
            try {
              locale.register(NS, localeId, dict);
            } catch {
              /* an earlier instance of this module (HMR) already registered the namespace */
            }
          }
        }
        try {
          return locale.bind(NS);
        } catch {
          /* fall through to the English table */
        }
      }
      return (key) => FALLBACK[key] ?? key;
    }

    async function readState(sessionId) {
      const query = typeof sessionId === 'string' && sessionId.length > 0 ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const response = await fetch(`/dsh-godot/state${query}`, { headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || `state request failed (HTTP ${response.status})`);
      return body.state;
    }

    async function sendControl(request) {
      const response = await fetch('/dsh-godot/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || `control request failed (HTTP ${response.status})`);
      return body.state;
    }

    function IconPlay() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M4 2.6v10.8L13 8 4 2.6z', fill: 'currentColor' }),
      );
    }

    function IconPause() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false },
        h('rect', { x: 3.5, y: 2.8, width: 3.2, height: 10.4, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 9.3, y: 2.8, width: 3.2, height: 10.4, rx: 1, fill: 'currentColor' }),
      );
    }

    function IconStop() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false },
        h('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 1.6, fill: 'currentColor' }),
      );
    }

    function IconGrip() {
      return h(
        'svg',
        { viewBox: '0 0 10 16', width: 10, height: 16, 'aria-hidden': true, focusable: false },
        ...[4.5, 8, 11.5].flatMap((y) =>
          [3, 7].map((x) => h('circle', { key: `${x}-${y}`, cx: x, cy: y, r: 1.1, fill: 'currentColor' })),
        ),
      );
    }

    const KEYFRAMES = '@keyframes dsh-godot-pulse{0%,100%{opacity:.35}50%{opacity:1}}';

    function buttonStyle(accent, disabled) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        padding: 0,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: accent,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        lineHeight: 1,
        boxSizing: 'border-box',
        flex: 'none',
      };
    }

    /** Invisible entry in the Session header: records which conversation is open. */
    function SessionBridge(props) {
      const sessionId = props && props.sessionId;
      React.useEffect(() => {
        setActiveSessionId(sessionId);
      }, [sessionId]);
      return null;
    }

    /** The movable floating panel itself. */
    function GodotFloat(props) {
      const translate = GodotFloat.translate;
      const [position, setPosition] = React.useState(() => clampPosition(readStoredPosition() || defaultPosition()));
      // `initialState` is a test seam: the slot passes no props in the browser.
      const [state, setState] = React.useState(props && props.initialState ? props.initialState : null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        let sequence = 0;
        const refresh = async () => {
          const wanted = activeSessionId;
          const mine = ++sequence;
          try {
            const next = await readState(wanted);
            // Drop a response that a newer request or a Session switch superseded.
            if (cancelled || mine !== sequence || activeSessionId !== wanted) return;
            setState(next);
          } catch (failure) {
            if (!cancelled) setError(String((failure && failure.message) || failure));
          }
        };
        refresh();
        const unlisten = onActiveSessionChange(() => {
          // Switching conversations must not keep the previous session's error.
          setError('');
          refresh();
        });
        const timer = setInterval(refresh, POLL_INTERVAL_MS);
        return () => {
          cancelled = true;
          unlisten();
          clearInterval(timer);
        };
      }, []);

      // Keep the panel inside the window when the window shrinks.
      React.useEffect(() => {
        const onResize = () => setPosition((current) => clampPosition(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      const startDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('button')) return;
        event.preventDefault();
        const originX = event.clientX;
        const originY = event.clientY;
        const base = position;
        let latest = base;
        const onMove = (moveEvent) => {
          latest = clampPosition({ left: base.left + (moveEvent.clientX - originX), top: base.top + (moveEvent.clientY - originY) });
          setPosition(latest);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          storePosition(latest);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      };

      const resetPosition = () => {
        const next = defaultPosition();
        setPosition(next);
        storePosition(next);
      };

      const act = async (action) => {
        setBusy(true);
        try {
          const next = await sendControl({ action, sessionId: activeSessionId || undefined });
          setState(next);
          setError('');
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setBusy(false);
        }
      };

      const running = Boolean(state && state.running);
      const paused = Boolean(state && state.paused);
      // Only appear where the page can actually act: the session's workspace
      // holds a Godot project. A running game stays visible so it can be paused
      // or stopped even if the workspace changes underneath it.
      const workspace = state && state.workspace ? state.workspace : null;
      const available = Boolean(state && (state.running || (workspace && workspace.available === true)));
      if (!available) return null;
      const toggleTitle = busy ? translate('busy') : !running ? translate('run') : paused ? translate('resume') : translate('pause');
      const statusText = busy ? translate('busy') : !running ? translate('idle') : paused ? translate('paused') : translate('running');
      const projectText = state && state.project ? state.projectName || state.project : workspace && workspace.projectName ? workspace.projectName : '';
      const detail = [statusText, projectText].filter((part) => part !== '').join(' · ');
      const tooltip = error
        ? `${translate('failed')}: ${error}`
        : `${detail || translate('idle')}\n${translate('moveHint')}`;
      const dotColor = error
        ? 'var(--dsw-alias-state-error-primary)'
        : !running
          ? 'var(--dsw-alias-state-idle-primary)'
          : paused
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)';

      const panelStyle = {
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: `${PANEL_WIDTH}px`,
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
        pointerEvents: 'auto',
        cursor: 'grab',
        userSelect: 'none',
        font: 'inherit',
      };

      const dragHandleStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '12px',
        height: '24px',
        color: 'var(--dsw-alias-label-secondary)',
        flex: 'none',
      };

      const labelStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
        flex: '1 1 auto',
        fontSize: '12px',
        lineHeight: 1.2,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      };

      return h(
        'div',
        {
          role: 'group',
          'aria-label': translate('groupLabel'),
          title: tooltip,
          style: panelStyle,
          onPointerDown: startDrag,
          onDoubleClick: resetPosition,
        },
        h('style', { key: 'kf' }, KEYFRAMES),
        h('span', { key: 'grip', style: dragHandleStyle, 'aria-hidden': true }, h(IconGrip)),
        h('span', {
          key: 'dot',
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: dotColor,
            flex: 'none',
            animation: busy ? 'dsh-godot-pulse 1.2s ease-in-out infinite' : undefined,
          },
          'aria-hidden': true,
        }),
        h('span', { key: 'label', style: labelStyle }, detail || translate('idle')),
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            title: toggleTitle,
            'aria-label': toggleTitle,
            disabled: busy,
            onClick: () => act('toggle'),
            style: buttonStyle('var(--dsw-alias-brand-primary)', busy),
          },
          running && !paused ? h(IconPause) : h(IconPlay),
        ),
        h(
          'button',
          {
            key: 'stop',
            type: 'button',
            title: translate('stop'),
            'aria-label': translate('stop'),
            disabled: busy || !running,
            onClick: () => act('stop'),
            style: buttonStyle('var(--dsw-alias-state-error-primary)', busy || !running),
          },
          h(IconStop),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const translate = createTranslator(ctx);
        GodotFloat.translate = translate;

        // Root overlay: the draggable floating panel.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'godot-float', order: 50, label: 'Godot' }, GodotFloat),
        );

        // Session header: invisible listener that tells the overlay which conversation is open.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'godot-session-bridge', order: 0, label: 'Godot' },
            SessionBridge,
          ),
        );
      },
    };
  },
});
