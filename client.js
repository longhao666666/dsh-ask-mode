/**
 * Consultation mode - CLIENT half.
 *
 * Official bundle client-artifact format: a side-effecting script that
 * registers ONE lazy factory through `window.__ModuleLoader__`, whose `id`
 * must equal the package name. React comes from the browser module table via
 * the injected `require`.
 *
 * One session-header badge next to the agent-preset label: it reads the
 * session's consultation state (preferably through the projection hook the
 * slot host passes in; polling the Host route as the fallback) and switches
 * it over POST /ask-mode. The Host half owns the actual fence (read-only
 * sandbox, editing-tool guard, the save_artifact tool); this half only flips
 * and shows it. Unlike the preset label beside it, this badge is a runtime
 * switch - it toggles any time, inside the live conversation.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ask-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Exact route the Host half answers. */
    const ROUTE = '/ask-mode';

    /** State poll cadence for the fallback path (no projection hook). */
    const POLL_MS = 2500;

    /** Chat-bubble outline, sized like the shipped header icons (14px). */
    const ChatIcon = ({ active }) => h(
      'svg',
      {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: active ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none' },
      },
      h('path', {
        d: 'M2.75 3h10.5a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75H8.2L5 13.6V11h-.25a.75.75 0 0 1-.75-.75v-6.5A.75.75 0 0 1 2.75 3z',
      }),
    );

    function createConsultBadge() {
      return function ConsultModeBadge(props) {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null;
        const useProjection = props && typeof props.useProjection === 'function' ? props.useProjection : null;

        const [fallback, setFallback] = React.useState({ active: false, pending: false });
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [hover, setHover] = React.useState(false);

        // Reactive path first: the projection's cropped { active } view.
        const view = useProjection !== null ? useProjection('ask') : undefined;

        const call = (body) => fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((res) => res.json());

        React.useEffect(() => {
          if (useProjection !== null || sessionId === null) return undefined;
          let stopped = false;
          const refresh = () => {
            call({ action: 'get', sessionId })
              .then((body) => {
                if (stopped || !body || !body.ok) return;
                setFallback({ active: body.active === true, pending: body.pending === true });
              })
              .catch(() => {});
          };
          refresh();
          const timer = window.setInterval(refresh, POLL_MS);
          return () => {
            stopped = true;
            window.clearInterval(timer);
          };
        }, [sessionId, useProjection]);

        const active = view !== undefined && view !== null
          ? view.active === true
          : fallback.active;
        const pending = view !== undefined && view !== null ? false : fallback.pending;

        const toggle = () => {
          if (busy || sessionId === null) return;
          setBusy(true);
          setError(null);
          call({ action: 'set', sessionId, active: !active })
            .then((body) => {
              if (body && body.ok) {
                setFallback({ active: body.active === true, pending: body.queued === true });
              } else {
                setError(body && body.error ? body.error : '切换失败');
              }
            })
            .catch((err) => setError(String(err && err.message ? err.message : err)))
            .finally(() => setBusy(false));
        };

        const label = active ? (pending ? '咨询中（下一步生效）' : '咨询中') : '咨询模式';
        const hint = active
          ? '咨询模式进行中：只读问答，修改类工具已禁用。点击退出，恢复完整工具与沙箱。'
          : '咨询模式：可查资料、搜索、看代码文档，不能修改已有内容；仅能新建 txt/md/docx 产出。点击进入。';

        return h(
          'button',
          {
            type: 'button',
            'data-dsh-consult-badge': active ? 'active' : 'idle',
            disabled: sessionId === null || busy,
            title: error !== null ? String(error) : sessionId === null ? '开始会话后可切换咨询模式' : hint,
            onClick: toggle,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '0 8px',
              minHeight: '28px',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              border: 'none',
              background: active
                ? 'var(--dsw-alias-state-business-primary, #3370ff)'
                : hover && sessionId !== null && !busy
                  ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))'
                  : 'transparent',
              color: active
                ? 'var(--dsw-alias-text-white-primary, #fff)'
                : 'var(--dsw-alias-label-primary, inherit)',
              fontSize: '13px',
              fontWeight: 500,
              lineHeight: '20px',
              whiteSpace: 'nowrap',
              cursor: sessionId === null || busy ? 'default' : 'pointer',
              opacity: sessionId === null ? 0.5 : 1,
            },
          },
          h(ChatIcon, { active }),
          label,
        );
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const Badge = createConsultBadge();
        // Session-header actions row: right beside the (read-only) agent-preset
        // label, which registers at order -10. This badge is the runtime
        // counterpart - a switch the preset label deliberately is not.
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'dsh-consult-mode-toggle',
            order: 0,
            inject: (sessionId) => ({ sessionId: typeof sessionId === 'string' ? sessionId : null }),
          },
          Badge,
        ));
      },
    };
  },
});
