/**
 * Client half of @local/dsh-godot: a run/pause button in the Session header.
 *
 * It renders one compact control in `conversation.session.header.utilities` and
 * talks to the package's own Host half over two loopback HTTP routes:
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

    const DICTIONARIES = {
      en: {
        run: 'Run game',
        pause: 'Pause game',
        resume: 'Resume game',
        stop: 'Stop game',
        running: 'Running',
        paused: 'Paused',
        idle: 'Not running',
        starting: 'Starting…',
        busy: 'Working…',
        failed: 'Godot control failed',
        groupLabel: 'Godot game controls',
      },
      zh: {
        run: '运行游戏',
        pause: '暂停游戏',
        resume: '继续游戏',
        stop: '停止游戏',
        running: '运行中',
        paused: '已暂停',
        idle: '未运行',
        starting: '启动中…',
        busy: '处理中…',
        failed: 'Godot 控制失败',
        groupLabel: 'Godot 游戏控制',
      },
    };

    const FALLBACK = DICTIONARIES.en;

    /**
     * Register the package dictionaries on the Client locale service and return
     * a translate function. The service is reached through `ctx.get` so the
     * plugin still mounts when it is absent, and falls back to English.
     */
    function createTranslator(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      try {
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          for (const [localeId, dict] of Object.entries(DICTIONARIES)) {
            locale.register(NS, localeId, dict);
          }
          return locale.bind(NS);
        }
      } catch {
        /* fall through to the English table */
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

    const GROUP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '0 2px',
      flex: 'none',
    };

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
      };
    }

    function dotStyle(color, pulsing) {
      return {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: color,
        flex: 'none',
        animation: pulsing ? 'dsh-godot-pulse 1.2s ease-in-out infinite' : undefined,
      };
    }

    const KEYFRAMES = '@keyframes dsh-godot-pulse{0%,100%{opacity:.35}50%{opacity:1}}';

    function GodotRunner(props) {
      const translate = props.translate;
      const sessionId = props.sessionId;
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
          try {
            const next = await readState(sessionId);
            if (!cancelled) setState(next);
          } catch (failure) {
            if (!cancelled) setError(String((failure && failure.message) || failure));
          }
        };
        refresh();
        const timer = setInterval(refresh, 2500);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      const act = async (action) => {
        setBusy(true);
        try {
          const next = await sendControl({ action, sessionId });
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
      const toggleTitle = busy ? translate('busy') : !running ? translate('run') : paused ? translate('resume') : translate('pause');
      const statusText = busy ? translate('busy') : !running ? translate('idle') : paused ? translate('paused') : translate('running');
      const projectText = state && state.project ? `${state.projectName || ''} — ${state.project}` : '';
      const detail = [statusText, projectText].filter((part) => part !== '').join(' · ');
      const groupTitle = error ? `${translate('failed')}: ${error}` : detail;
      const dotColor = error
        ? 'var(--dsw-alias-state-error-primary)'
        : !running
          ? 'var(--dsw-alias-state-idle-primary)'
          : paused
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)';

      return h(
        'div',
        { role: 'group', 'aria-label': translate('groupLabel'), title: groupTitle, style: GROUP_STYLE },
        h('style', { key: 'kf' }, KEYFRAMES),
        h('span', { key: 'dot', style: dotStyle(dotColor, busy), 'aria-hidden': true }),
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
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'godot-runner', order: 20, label: 'Godot' },
            (props) => h(GodotRunner, { translate, sessionId: props.sessionId }),
          ),
        );
      },
    };
  },
});
