import type { WidgetPayload } from './reviewEngine'

/**
 * The embeddable review widget.
 *
 * Public, unauthenticated, and rendered on somebody else's website. That last
 * point governs everything here:
 *
 *  - **Zero dependencies.** The script must not pull a framework onto a
 *    customer's page. It is plain DOM in an IIFE.
 *
 *  - **Everything is escaped.** Review bodies and author names are attacker-
 *    influenced strings — anyone with a submission link can put text in one —
 *    that end up in the DOM of a business's public site. `innerHTML` is not used
 *    with any of it; nodes are built with `textContent`. An XSS here is not a
 *    bug in this product, it is a bug in every customer's website at once.
 *
 *  - **Styles are scoped and injected once**, under a unique prefix, so the
 *    widget cannot restyle the host page and the host page's CSS is unlikely to
 *    disfigure it.
 *
 *  - **Schema.org `AggregateRating` is emitted as JSON-LD**, computed over the
 *    reviews actually shown. Emitting an aggregate over reviews a visitor
 *    cannot see would be a figure nobody can verify, and search engines
 *    penalise exactly that.
 */

const CLASS_PREFIX = 'lf-rw'

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character
  ))
}

/**
 * Structured data for the aggregate rating.
 *
 * Serialised through JSON.stringify and then escaped for the one sequence that
 * can break out of a script element. A raw `</script>` inside a review body
 * would otherwise terminate the block early and put the remainder of the review
 * into the document as markup.
 */
export function aggregateRatingJsonLd(input: {
  businessName: string
  aggregate: { ratingValue: number; reviewCount: number } | null
}): string | null {
  if (!input.aggregate) return null
  const document = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: input.businessName,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: input.aggregate.ratingValue,
      reviewCount: input.aggregate.reviewCount,
      bestRating: 5,
      worstRating: 1,
    },
  }
  return JSON.stringify(document)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

/** Server-rendered markup, for hosts that prefer not to run a script. */
export function renderWidgetHtml(input: { businessName: string; payload: WidgetPayload }): string {
  const { payload } = input
  const stars = (rating: number) => '★'.repeat(Math.max(0, Math.min(5, Math.round(rating)))).padEnd(5, '☆')

  const aggregate = payload.aggregate
    ? `<div class="${CLASS_PREFIX}-aggregate"><span class="${CLASS_PREFIX}-stars">${stars(payload.aggregate.ratingValue)}</span>`
      + `<strong>${payload.aggregate.ratingValue.toFixed(1)}</strong>`
      + `<span>${payload.aggregate.reviewCount} review${payload.aggregate.reviewCount === 1 ? '' : 's'}</span></div>`
    : ''

  const items = payload.reviews.map((review) => (
    `<li class="${CLASS_PREFIX}-item">`
    + `<div class="${CLASS_PREFIX}-stars">${stars(review.rating)}</div>`
    + `<p class="${CLASS_PREFIX}-body">${escapeHtml(review.body)}</p>`
    + `<div class="${CLASS_PREFIX}-author">${escapeHtml(review.authorName)}</div>`
    + (review.reply ? `<p class="${CLASS_PREFIX}-reply">${escapeHtml(review.reply.body)}</p>` : '')
    + '</li>'
  )).join('')

  const jsonLd = aggregateRatingJsonLd({ businessName: input.businessName, aggregate: payload.aggregate })

  return `<div class="${CLASS_PREFIX} ${CLASS_PREFIX}-${escapeHtml(payload.layout)}">`
    + aggregate
    + `<ul class="${CLASS_PREFIX}-list">${items}</ul>`
    + (jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : '')
    + '</div>'
}

/**
 * The embed script.
 *
 * Served as JavaScript from the public endpoint. It fetches its own payload,
 * builds the DOM with `textContent` throughout, and injects scoped styles once.
 *
 * Note the deliberate absence of `innerHTML` anywhere content is involved: the
 * one place it appears is a static stylesheet string with no interpolation.
 */
export function widgetScript(input: { publicKey: string; apiBaseUrl: string; businessName: string }): string {
  const endpoint = `${input.apiBaseUrl.replace(/\/$/, '')}/api/v1/public/reviews/widget/${encodeURIComponent(input.publicKey)}`
  return `(function () {
  'use strict';
  var PREFIX = '${CLASS_PREFIX}';
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var BUSINESS = ${JSON.stringify(input.businessName)};

  function injectStyles(accent, dark) {
    if (document.getElementById(PREFIX + '-styles')) return;
    var style = document.createElement('style');
    style.id = PREFIX + '-styles';
    // Static stylesheet, no interpolated content. Colours are validated
    // server-side before reaching here.
    style.textContent = [
      '.' + PREFIX + '{font-family:system-ui,-apple-system,sans-serif;color:' + (dark ? '#e5e7eb' : '#111827') + ';}',
      '.' + PREFIX + '-list{list-style:none;margin:0;padding:0;display:grid;gap:12px;}',
      '.' + PREFIX + '-grid .' + PREFIX + '-list{grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}',
      '.' + PREFIX + '-carousel .' + PREFIX + '-list{grid-auto-flow:column;grid-auto-columns:minmax(260px,1fr);overflow-x:auto;scroll-snap-type:x mandatory;}',
      '.' + PREFIX + '-carousel .' + PREFIX + '-item{scroll-snap-align:start;}',
      '.' + PREFIX + '-item{border:1px solid ' + (dark ? '#374151' : '#e5e7eb') + ';border-radius:10px;padding:14px;background:' + (dark ? '#111827' : '#fff') + ';}',
      '.' + PREFIX + '-stars{color:' + accent + ';letter-spacing:2px;font-size:15px;}',
      '.' + PREFIX + '-body{margin:8px 0;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.' + PREFIX + '-author{font-size:13px;opacity:.75;}',
      '.' + PREFIX + '-reply{margin:8px 0 0;padding-left:10px;border-left:3px solid ' + accent + ';font-size:13px;opacity:.85;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.' + PREFIX + '-aggregate{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px;}',
      '.' + PREFIX + '-badge{position:fixed;right:16px;bottom:16px;z-index:2147483000;box-shadow:0 4px 16px rgba(0,0,0,.18);border-radius:10px;padding:10px 14px;background:' + (dark ? '#111827' : '#fff') + ';}'
    ].join('');
    document.head.appendChild(style);
  }

  function stars(rating) {
    var whole = Math.max(0, Math.min(5, Math.round(rating)));
    return new Array(whole + 1).join('\\u2605') + new Array(6 - whole).join('\\u2606');
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, never innerHTML. Review bodies and author names are
    // attacker-influenced and land on a customer's public website.
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function render(mount, data) {
    var theme = data.theme || {};
    injectStyles(theme.accentColor || '#2563eb', Boolean(theme.darkMode));

    var root = element('div', PREFIX + ' ' + PREFIX + '-' + (data.layout || 'carousel'));

    if (data.aggregate) {
      var summary = element('div', PREFIX + '-aggregate');
      summary.appendChild(element('span', PREFIX + '-stars', stars(data.aggregate.ratingValue)));
      summary.appendChild(element('strong', null, data.aggregate.ratingValue.toFixed(1)));
      summary.appendChild(element('span', null, data.aggregate.reviewCount + ' review' + (data.aggregate.reviewCount === 1 ? '' : 's')));
      root.appendChild(summary);

      var ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'LocalBusiness',
        name: BUSINESS,
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: data.aggregate.ratingValue,
          reviewCount: data.aggregate.reviewCount,
          bestRating: 5,
          worstRating: 1
        }
      });
      root.appendChild(ld);
    }

    var list = element('ul', PREFIX + '-list');
    (data.reviews || []).forEach(function (review) {
      var item = element('li', PREFIX + '-item');
      item.appendChild(element('div', PREFIX + '-stars', stars(review.rating)));
      if (review.body) item.appendChild(element('p', PREFIX + '-body', review.body));
      item.appendChild(element('div', PREFIX + '-author', review.authorName));
      if (review.reply && review.reply.body) item.appendChild(element('p', PREFIX + '-reply', review.reply.body));
      list.appendChild(item);
    });
    root.appendChild(list);

    mount.textContent = '';
    mount.appendChild(root);
  }

  function mountPoints() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-' + PREFIX + ']'));
  }

  function start() {
    var mounts = mountPoints();
    if (!mounts.length) return;
    fetch(ENDPOINT, { credentials: 'omit' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        // Silent on failure. A review widget that renders an error message on a
        // customer's homepage is worse than one that renders nothing.
        if (!data) return;
        mounts.forEach(function (mount) { render(mount, data); });
      })
      .catch(function () { });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`
}

/** Colours reaching the stylesheet are constrained to a hex literal. */
export function safeAccentColor(value: unknown): string {
  const candidate = String(value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : '#2563eb'
}
