/**
 * Consultation mode - HOST half.
 *
 * A Q&A collaboration mode in the shape of the shipped plan mode: one logged
 * per-session state (the `ask` projection folds `ask/mode` events, so resume
 * and fork restore it), a `ask:policy` prompt section while active, the
 * `/ask` command, and a `/ask-mode` HTTP route the Client header badge calls.
 *
 * The fence is the shipped per-session sandbox override, not a tool rewrite:
 * entering ask mode appends one `sandbox/mode` read-only event (the same
 * write path `dsh-sandbox-policy`'s setSandboxMode uses), so every confined
 * capability - the pwsh/bash shell AND the filesystem tools - turns read-only
 * for that session. A `session/created` listener propagates the fence to
 * freshly spawned subagent sessions (forks inherit it by event replay), and a
 * global tools guard refuses the editing tools with an ask-mode explanation
 * instead of a raw sandbox denial. Leaving ask mode restores the sandbox mode
 * that was effective before entering.
 *
 * The one sanctioned write path is the `save_artifact` tool: it creates NEW
 * txt/markdown/docx files and new directories only. It checks the target is
 * absent, refuses anything outside the session workspace, writes text through
 * the `ctx.fs` seam with a createIfAbsent intent, and uses the `wx` flag for
 * docx bytes (ctx.fs is text-only by contract). It resolves its own
 * workspace-write policy - an explicit mode outranks the session's read-only
 * override in `sandboxPolicy.resolve` - so the red line ("never touch
 * anything that already exists") and the white line ("create deliverables
 * the user explicitly asked for") are both enforced in tool code, on top of
 * the prompt-level behavior section.
 *
 * The tool catalog stays stable across mode switches (KV cache): no tool is
 * registered or unregistered when ask mode toggles.
 */
import { mkdir, stat as statHostPath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolveHostPath } from 'node:path';

/** Exact route the Client half calls. */
const ROUTE_PATH = '/ask-mode';

/** Request-body ceiling for the route. */
const BODY_LIMIT = 16 * 1024;

/** Ask mode never writes a deliverable larger than this. */
const MAX_CONTENT_CHARS = 2000000;

/** Editing tools refused with an ask-mode explanation while the fence is up. */
const DENIED_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** The behavior section, injected into each model request while consultation mode is active. */
const ASK_SECTION = `
# Consultation mode

This conversation is in consultation mode: the user wants answers, research, and explanations - not changes.

- Answer directly in the conversation. You may search the web, read files, list directories, and inspect the codebase freely.
- Never modify, move, rename, or delete anything that already exists. Editing tools are refused in consultation mode and the file sandbox is read-only; do not attempt to work around this.
- The only exception is creating NEW deliverables, and only when the user explicitly asks for one (for example "整理成 markdown", "生成一份报告", "save this as a document"): use the save_artifact tool with a fresh path that does not exist yet. It refuses to overwrite anything - pick a new filename instead.
- When you believe a change is genuinely needed, describe it instead (which file, where, what to change) and suggest the user leave consultation mode to apply it.
`.trim();

/** The model-facing deliverable tool's description. */
const ARTIFACT_DESCRIPTION = [
  "Consultation mode's deliverable tool. Creates one NEW file (txt, markdown, or docx) or a new directory;",
  'use it only in consultation mode and only when the user explicitly asked for a saved deliverable (a summary,',
  'a report, organized notes). The target path must not exist: this tool never overwrites or modifies',
  'existing content - choose a fresh filename. docx files are generated from simple markdown',
  '(# headings, paragraphs, - bullet lists).',
].join(' ');

//#region docx
/** CRC-32 (IEEE 802.3) table for the stored-zip writer. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 of one byte buffer, as an unsigned 32-bit integer. */
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** DOS date/time fields for one zip entry, from the current clock. */
function dosDateTime(date) {
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31),
    day: (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

/**
 * Build a stored (uncompressed) zip archive. Every entry keeps its raw bytes,
 * so no compression dependency is needed and the result opens in Word.
 * @param entries - `{ name, data }` pairs; data is a Uint8Array.
 * @returns the archive bytes.
 */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** Escape one text run for XML character data. */
function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render simple markdown lines as WordprocessingML paragraphs. */
function docxParagraphs(markdown) {
  const out = [];
  for (const raw of String(markdown).split(/\r\n|\r|\n/)) {
    let text = raw;
    let style = null;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      style = 'Heading' + Math.min(heading[1].length, 3);
      text = heading[2];
    } else if (/^\s*[-*+]\s+/.test(text)) {
      text = '\u2022 ' + text.replace(/^\s*[-*+]\s+/, '');
    }
    if (text.trim() === '' && style === null) {
      out.push('<w:p/>');
      continue;
    }
    out.push(
      '<w:p>'
      + (style === null ? '' : '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>')
      + '<w:r><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r></w:p>',
    );
  }
  return out.join('');
}

/** Build a minimal valid .docx (OOXML package in a stored zip) from markdown-ish text. */
function buildDocx(markdown) {
  const encode = (text) => new TextEncoder().encode(text);
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + [1, 2, 3].map((n) => '<w:style w:type="paragraph" w:styleId="Heading' + n + '">'
      + '<w:name w:val="heading ' + n + '"/><w:basedOn w:val="Normal"/>'
      + '<w:pPr><w:outlineLvl w:val="' + (n - 1) + '"/></w:pPr>'
      + '<w:rPr><w:b/><w:sz w:val="' + (32 - n * 4) + '"/></w:rPr></w:style>').join('')
    + '</w:styles>';
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + docxParagraphs(markdown)
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
  return buildZip([
    { name: '[Content_Types].xml', data: encode(contentTypes) },
    { name: '_rels/.rels', data: encode(rels) },
    { name: 'word/_rels/document.xml.rels', data: encode(docRels) },
    { name: 'word/styles.xml', data: encode(styles) },
    { name: 'word/document.xml', data: encode(doc) },
  ]);
}
//#endregion

//#region projection
/**
 * Hand-rolled schema stand-ins for the projection registry's `parse` contract
 * (zod duck-typing): validate the persisted shape and return a detached value.
 */
const askStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ask state must be an object');
    if (typeof value.active !== 'boolean') throw new Error('ask state `active` must be a boolean');
    const restoreMode = value.restoreMode;
    if (restoreMode !== null && restoreMode !== undefined && typeof restoreMode !== 'string') throw new Error('ask state `restoreMode` must be a string or null');
    return { active: value.active, restoreMode: restoreMode ?? null };
  },
};

const askViewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ask view must be an object');
    if (typeof value.active !== 'boolean') throw new Error('ask view `active` must be a boolean');
    return { active: value.active };
  },
};

/** Projection of logged ask-mode selections: the durable state resume/fork restore. */
const askProjectionDefinition = {
  key: 'ask',
  stateVersion: 1,
  stateSchema: askStateSchema,
  init: () => ({ active: false, restoreMode: null }),
  apply: (state, event) => {
    if (event.type === 'ask/mode') {
      return {
        active: event.data.active === true,
        restoreMode: typeof event.data.restoreMode === 'string' ? event.data.restoreMode : null,
      };
    }
    return state;
  },
  wire: {
    viewSchema: askViewSchema,
    view: (state) => ({ active: state.active }),
  },
};
//#endregion

/** Collect a request body with a hard size cap. */
async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Answer one request with JSON. */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export const name = 'ask-mode';
export const inject = [
  'systemPrompt',
  'tools',
  'sessionProjections',
  'sessions',
  'sandboxPolicy',
  'webServer',
  'connection',
  'fs',
];

export function apply(ctx) {
  /** Selections per session awaiting the next accepted in-turn pre-step. */
  const pendingIntents = new WeakMap();

  ctx.sessionProjections.register(askProjectionDefinition);

  /** Read the required ask projection state or fail at the first service access. */
  const askState = (session) => {
    const state = ctx.sessionProjections.stateOf(session, 'ask');
    if (state === undefined) throw new Error('ask-mode requires the ask session projection');
    return state;
  };

  const loggedActive = (session) => askState(session).active;

  const hasOpenTurn = (session) => {
    const state = ctx.sessionProjections.stateOf(session, 'turnBoundary');
    if (state === undefined) throw new Error('ask-mode requires the turnBoundary session projection');
    return state.openTurnStartSeq !== null;
  };

  /**
   * Whether ask mode is active for the session itself or any ancestor still
   * live in the store (spawn children carry `parentSession`; forks replay the
   * events). Cycle-safe; the first read failure resolves "not fenced".
   */
  const askActiveInLineage = (session) => {
    const seen = new Set();
    let current = session;
    while (current !== undefined && current !== null) {
      const id = current.header?.id;
      if (typeof id !== 'string' || seen.has(id)) break;
      seen.add(id);
      try {
        if (loggedActive(current)) return true;
      } catch (error) {
        ctx.logger.warn('ask-mode: lineage read failed: %o', error);
        return false;
      }
      const parentId = current.header?.parentSession;
      current = typeof parentId === 'string' ? ctx.sessions.get(parentId) : undefined;
    }
    return false;
  };

  /**
   * Append the mode switch. Entering captures the sandbox override effective
   * right now (before the read-only event lands) and pins read-only; leaving
   * restores the captured mode, or the deployment default when there was none.
   */
  const commit = (session, active) => {
    if (active) {
      const restoreMode = ctx.sandboxPolicy.overrideOf(session) ?? null;
      session.append('ask/mode', { active: true, restoreMode });
      session.append('sandbox/mode', { mode: 'read-only' });
      return;
    }
    const restore = askState(session).restoreMode ?? ctx.sandboxPolicy.defaultMode;
    session.append('ask/mode', { active: false, restoreMode: null });
    session.append('sandbox/mode', { mode: restore });
  };

  /**
   * Select whether ask mode should be active. Between turns the change is
   * appended immediately; during an open turn it stays pending until the next
   * accepted in-turn pre-step (mirrors the plan-mode selection protocol).
   * @returns `committed` | `queued` | `cancelled` | `noop`.
   */
  const set = (session, active) => {
    if (active === (pendingIntents.get(session)?.active ?? loggedActive(session))) return 'noop';
    if (hasOpenTurn(session)) {
      pendingIntents.set(session, { active });
      return loggedActive(session) === active ? 'cancelled' : 'queued';
    }
    if (active === loggedActive(session)) {
      pendingIntents.delete(session);
      return 'cancelled';
    }
    commit(session, active);
    pendingIntents.delete(session);
    return 'committed';
  };

  // The behavior section, injected while active or pending-active.
  ctx.systemPrompt.section({
    name: 'ask:policy',
    order: 550,
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined) return '';
      const pending = pendingIntents.get(agent.session);
      const active = pending !== undefined ? pending.active : loggedActive(agent.session);
      return active ? ASK_SECTION : '';
    },
  });

  // Apply a pending selection before the next request assembly.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    const pending = pendingIntents.get(agent.session);
    if (pending === undefined) return decision;
    try {
      if (pending.active !== loggedActive(agent.session)) commit(agent.session, pending.active);
      pendingIntents.delete(agent.session);
    } catch (error) {
      ctx.logger.warn('ask-mode: failed to apply the pending ask-mode switch at step start: %o', error);
    }
    return decision;
  });

  // Friendly refusal layer on top of the sandbox fence: the editing tools
  // fail with an ask-mode explanation instead of a raw sandbox denial (and
  // never reach their escalation guidance). The shell stays available as a
  // read-only shell, fenced by the sandbox itself.
  ctx.tools.guard((exec) => {
    const agent = exec.agent;
    if (agent === undefined) return undefined;
    if (!DENIED_TOOLS.has(exec.name)) return undefined;
    let fenced = false;
    try {
      fenced = askActiveInLineage(agent.session);
    } catch {
      return undefined;
    }
    if (!fenced) return undefined;
    return 'Consultation mode is active for this conversation: the "' + exec.name + '" tool is disabled.'
      + ' Consultation mode is read-only - answer in the conversation, or use save_artifact to create a NEW file when the user explicitly asks for one.';
  });

  // Propagate the fence to freshly created child sessions (spawn subagents;
  // forks replay the parent events anyway, and a duplicate append is a no-op
  // fold). Over-restrictive on stale children after the parent leaves ask
  // mode - the safe direction. Must never throw: a throwing session/created
  // listener rolls the session attach back.
  ctx.on('session/created', (session) => {
    try {
      const parentId = session.header?.parentSession;
      if (typeof parentId !== 'string') return;
      const parent = ctx.sessions.get(parentId);
      if (parent === undefined) return;
      if (!askActiveInLineage(parent)) return;
      session.append('sandbox/mode', { mode: 'read-only' });
      session.append('ask/mode', { active: true, restoreMode: null });
    } catch (error) {
      ctx.logger.warn('ask-mode: failed to fence a newly created child session: %o', error);
    }
  });

  /** Resolve the deliverable format: explicit parameter, then extension, then txt. */
  const artifactFormat = (args, path) => {
    const explicit = typeof args.format === 'string' ? args.format.toLowerCase() : undefined;
    if (explicit !== undefined && !['txt', 'markdown', 'docx'].includes(explicit)) {
      throw new Error('format must be one of txt, markdown, docx');
    }
    if (explicit !== undefined) return explicit;
    if (/\.md$/i.test(path)) return 'markdown';
    if (/\.docx$/i.test(path)) return 'docx';
    return 'txt';
  };

  /** Keep node:fs deliverables inside the session workspace. */
  const assertInWorkspace = (hostPath, root) => {
    const rel = relative(resolveHostPath(root), resolveHostPath(hostPath));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Consultation-mode deliverables stay inside the session workspace (' + root + '): ' + hostPath + ' is outside it.');
    }
  };

  // The sanctioned write path: create-new-only, workspace-confined.
  ctx.tools.register({
    name: 'save_artifact',
    description: ARTIFACT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path of the NEW file or directory to create. It must not already exist - this tool never overwrites.',
        },
        content: {
          type: 'string',
          description: 'Full text content for the file. For docx, simple markdown is supported (# headings, paragraphs, - bullet lists).',
        },
        format: {
          type: 'string',
          enum: ['txt', 'markdown', 'docx'],
          description: 'Output format; defaults to the path extension, txt when unknown.',
        },
        create_directory: {
          type: 'boolean',
          description: 'True to create a directory at `path` instead of a file (content is then ignored).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (rawPath === '') throw new Error('path must be a non-empty string');
      if (!isAbsolute(rawPath)) throw new Error('The path ' + rawPath + ' is not an absolute path.');
      const session = exec.agent?.session;
      // An explicit mode outranks the session's read-only override: the only
      // sanctioned write policy, still confined to the workspace root.
      const policy = ctx.sandboxPolicy.resolve({
        ...(session === undefined ? {} : { session }),
        mode: 'workspace-write',
      });
      const target = await ctx.fs.resolve(rawPath, { signal: exec.signal });
      if (await ctx.fs.stat(target, exec.signal) !== undefined) {
        throw new Error('Consultation mode never touches existing paths: ' + target.displayPath + ' already exists. Choose a fresh path.');
      }
      if (args.create_directory === true) {
        const hostPath = resolveHostPath(rawPath);
        assertInWorkspace(hostPath, policy.workspaceRoot);
        await mkdir(hostPath, { recursive: true });
        return 'New directory created: ' + target.displayPath;
      }
      if (typeof args.content !== 'string') throw new Error('content is required when creating a file');
      if (args.content.length > MAX_CONTENT_CHARS) {
        throw new Error('content exceeds the ' + MAX_CONTENT_CHARS + '-character consultation-mode deliverable cap');
      }
      const format = artifactFormat(args, rawPath);
      if (format === 'docx') {
        const hostPath = resolveHostPath(rawPath);
        assertInWorkspace(hostPath, policy.workspaceRoot);
        const bytes = buildDocx(args.content);
        // `wx`: the create fails atomically if anything created the file first.
        try {
          await writeFile(hostPath, bytes, { flag: 'wx' });
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
            throw new Error('Consultation mode never touches existing paths: ' + target.displayPath + ' already exists. Choose a fresh path.');
          }
          throw error;
        }
        return 'New docx created: ' + target.displayPath + ' (' + bytes.length + ' bytes)';
      }
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' }));
      const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policy);
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
      return 'New file created: ' + target.displayPath;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'create ' + (typeof args?.path === 'string' ? args.path : 'artifact'),
      kind: 'edit',
      locations: [{ path: typeof args?.path === 'string' ? args.path : '' }],
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Artifact created',
      content: result.content,
    }),
  });

  // The /ask command: /ask enters, /ask off leaves.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: '@local/dsh-ask-mode',
      name: 'ask',
      description: 'Enter or leave consultation mode (read-only Q&A)',
      input: { hint: '[off]', attachments: false },
      handler: ({ agent, rawInput }) => {
        const message = rawInput.trim();
        if (message !== '' && message !== 'off') {
          return {
            kind: 'error',
            text: 'Usage: /ask (enter consultation mode) or /ask off (leave). Ask your question directly in chat.',
          };
        }
        const wantOff = message === 'off';
        const outcome = set(agent.session, !wantOff);
        if (!wantOff) {
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? 'Consultation mode on. Reads, searches, and new deliverables only; use /ask off to leave.'
              : 'Entering consultation mode (applies from the next step). Use /ask off to leave.',
          };
        }
        switch (outcome) {
          case 'committed': return { kind: 'success', text: 'Consultation mode off.' };
          case 'queued': return { kind: 'success', text: 'Leaving consultation mode (applies from the next step).' };
          case 'cancelled': return { kind: 'success', text: 'Leaving consultation mode (applies from the next step).' };
          case 'noop': return loggedActive(agent.session)
            ? { kind: 'success', text: 'Leaving consultation mode (applies from the next step).' }
            : { kind: 'success', text: 'Consultation mode is already inactive.' };
        }
      },
    });
  });

  /**
   * Answer an untrusted or unauthenticated request; true when it was rejected.
   * Same Host/Origin + browser-authentication fence the shipped routes use.
   */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  // The Client half's toggle: POST { action: 'get' | 'set', sessionId, active }.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method ' + req.method + ' not allowed' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.sessionId !== 'string' || parsed.sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'sessionId (string) is required' });
        return;
      }
      const session = ctx.sessions.get(parsed.sessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, error: 'unknown session' });
        return;
      }
      if (parsed.action === 'get') {
        let active = false;
        let pending = false;
        try {
          active = loggedActive(session);
          pending = (pendingIntents.get(session)?.active ?? active) !== active;
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          return;
        }
        sendJson(res, 200, { ok: true, active, pending });
        return;
      }
      if (parsed.action === 'set') {
        if (typeof parsed.active !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'active (boolean) is required for action "set"' });
          return;
        }
        let outcome;
        try {
          outcome = set(session, parsed.active);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          return;
        }
        let active = parsed.active;
        try {
          active = loggedActive(session);
        } catch { /* the pending selection is the best answer available */ }
        sendJson(res, 200, { ok: true, outcome, active, queued: outcome === 'queued' });
        return;
      }
      sendJson(res, 400, { ok: false, error: 'action must be "get" or "set"' });
    },
  }), 'ask-mode: /ask-mode route');
}
