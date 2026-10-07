/**
 * Rendering (B032, card test email.render.test.ts): golden HTML and text for each template,
 * escaping (acceptance 1) with a property test over random strings, links used exactly as given,
 * the subject limit, parameter checks, and the `html` tag and registry that later lanes use.
 */
import { hasControlChars } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  createTemplateRegistry,
  escapeHtml,
  markup,
  MAX_SUBJECT_LENGTH,
  renderTemplate,
  type EmailTemplate,
  type TemplateId,
} from '../../src/index.js';
import { setup } from './helpers.js';

const FIXED = {
  workspace_invite: {
    inviterName: 'Ada Lovelace',
    workspaceName: 'Analytical Engines',
    url: 'https://centcom.dev/i/TOKEN',
    expiresAt: new Date('2026-10-14T12:00:00Z'),
  },
  account_deletion_scheduled: {
    displayName: 'Ada',
    deletionDate: new Date('2026-11-06T12:00:00Z'),
    restoreUrl: 'https://centcom.dev/account/restore',
  },
  export_ready: {
    displayName: 'Ada',
    url: 'https://centcom.dev/exports/EXPORT',
    expiresAt: new Date('2026-10-08T12:00:00Z'),
  },
} as const;

const count = (text: string, c: string): number => text.split(c).length - 1;

describe('the templates', () => {
  it.each(Object.keys(FIXED) as TemplateId[])(
    'render %s as their golden HTML and text',
    async (id) => {
      const { service } = setup();
      const rendered = service.render(id, FIXED[id] as never);
      expect(rendered.from).toBe('Centcom <no-reply@centcom.test>');
      expect(rendered.tag).toBe(id);
      expect(rendered.text.trim().length).toBeGreaterThan(0);
      await expect(rendered.html).toMatchFileSnapshot(`./golden/${id}.html.golden`);
      await expect(`Subject: ${rendered.subject}\n\n${rendered.text}`).toMatchFileSnapshot(
        `./golden/${id}.txt.golden`,
      );
    },
  );

  it('escape markup in HTML and keep it raw in the text part (acceptance 1)', () => {
    const { service } = setup();
    const rendered = service.render('workspace_invite', {
      ...FIXED.workspace_invite,
      inviterName: '<script>x</script>',
      workspaceName: `"Tom & Jerry's"`,
    });
    expect(rendered.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&quot;Tom &amp; Jerry&#39;s&quot;');
    expect(rendered.text).toContain('<script>x</script> invited you to join "Tom & Jerry\'s"');
    expect(rendered.subject).toBe(`<script>x</script> invited you to "Tom & Jerry's" on Centcom`);
  });

  it('never let a parameter add markup, whatever it holds (property)', () => {
    const { service } = setup();
    const neutral = service.render('workspace_invite', FIXED.workspace_invite);
    const text = fc
      .string({ minLength: 1, maxLength: 200 })
      .filter((s) => !hasControlChars(s) && !/[\r\n]/.test(s));
    fc.assert(
      fc.property(text, text, (inviterName, workspaceName) => {
        const rendered = service.render('workspace_invite', {
          ...FIXED.workspace_invite,
          inviterName,
          workspaceName,
        });
        for (const c of ['<', '>']) expect(count(rendered.html, c)).toBe(count(neutral.html, c));
        for (const value of [inviterName, workspaceName]) {
          expect(rendered.html).toContain(escapeHtml(value));
          expect(rendered.text).toContain(value);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('use links exactly as given: no tracking, no redirect', () => {
    const { service } = setup();
    const url = 'https://centcom.dev/i/abc?x=1&y=2#k=key';
    const rendered = service.render('workspace_invite', { ...FIXED.workspace_invite, url });
    expect(rendered.html).toContain(`<a href="${escapeHtml(url)}">`);
    expect(rendered.text).toContain(url);
    expect(count(rendered.html, '<a ')).toBe(1);
  });

  it('cut a long subject to 150 characters', () => {
    const { service } = setup();
    const rendered = service.render('workspace_invite', {
      ...FIXED.workspace_invite,
      inviterName: 'I'.repeat(200),
      workspaceName: 'W'.repeat(200),
    });
    expect(rendered.subject).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(rendered.subject.endsWith('…')).toBe(true);
  });

  it('refuse bad parameters, listing each with its pointer', () => {
    const { service } = setup();
    let error: unknown;
    try {
      service.render('workspace_invite', {
        inviterName: '',
        workspaceName: 'a\nb',
        url: 'javascript:alert(1)',
        expiresAt: new Date('nope'),
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).errors?.map((e) => [e.pointer, e.code])).toEqual([
      ['/params/inviterName', 'invalid_format'],
      ['/params/workspaceName', 'invalid_format'],
      ['/params/url', 'invalid_format'],
      ['/params/expiresAt', 'invalid_type'],
    ]);
    expect(() => service.render('export_ready', 'not params' as never)).toThrow(AppError);
  });

  it.each([
    'http://centcom.dev/i/x',
    'https://user:pass@centcom.dev/x',
    'ftp://centcom.dev/x',
    'centcom://invite/x',
    `https://centcom.dev/${'x'.repeat(2048)}`,
    42,
  ])('refuse the link %j', (url) => {
    const { service } = setup();
    expect(() =>
      service.render('export_ready', { ...FIXED.export_ready, url: url as string }),
    ).toThrow(AppError);
  });

  it('accept http links to localhost, for development', () => {
    const { service } = setup();
    const url = 'http://localhost:5173/exports/x';
    expect(service.render('export_ready', { ...FIXED.export_ready, url }).text).toContain(url);
  });
});

describe('markup and the registry', () => {
  /** A template only tests use, rendering whatever its body says. */
  const note: EmailTemplate<{ name: string }> = {
    params: { name: 'text' },
    subject: (p) => `Note for ${p.name}`,
    html: (p) =>
      markup`<p>${p.name}: ${markup`<b>${'<i>'}</b>`} ${['<a>', markup`<br>`]} ${42}</p>`,
    text: (p) => `Note for ${p.name}`,
  };

  it('escapes every value but HTML it built, and joins arrays', () => {
    const registry = createTemplateRegistry();
    registry.registerTemplate('test_note' as TemplateId, note as never);
    const template = registry.get('test_note');
    if (template === undefined) throw new Error('not registered');
    const rendered = renderTemplate('test_note', template, { name: 'A&B' });
    expect(rendered.html).toContain('<p>A&amp;B: <b>&lt;i&gt;</b> &lt;a&gt;<br> 42</p>');
    expect(rendered.subject).toBe('Note for A&B');
    expect(rendered.text).toBe(
      'Note for A&B\n\n--\nYou received this email because of activity on your Centcom account.\n',
    );
  });

  it('holds the three templates, refuses a taken id, and is per service', () => {
    const registry = createTemplateRegistry();
    expect(registry.ids().sort()).toEqual([
      'account_deletion_scheduled',
      'export_ready',
      'workspace_invite',
    ]);
    expect(() => registry.registerTemplate('export_ready', note as never)).toThrow(TypeError);
    registry.registerTemplate('test_note' as TemplateId, note as never);
    expect(createTemplateRegistry().get('test_note')).toBeUndefined();
  });
});
