/**
 * vwap local UI.
 *
 * Nothing here signs or submits. The page asks the local server to build an
 * unsigned transaction and hands it to the wallet the user chooses.
 *
 * Every dynamic string is escaped before it reaches innerHTML. Token names and
 * symbols come from an on-chain registry, which means anyone who can mint a
 * token can choose them -- a token called "<img onerror=...>" is a realistic
 * thing to encounter, not a hypothetical.
 */

const $ = (id) => document.getElementById(id);

/** Escape for HTML text and quoted attribute contexts. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const usd = (n) => n >= 1_000_000 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 1_000 ? `$${(n / 1e3).toFixed(1)}K` : `$${Number(n).toFixed(2)}`;
const pct = (n, dp = 3) => Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : 'n/a';

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

function busy(btn, statusEl, text) {
  btn.disabled = true;
  statusEl.innerHTML = `<span class="spinner"></span> ${esc(text)}`;
  return () => { btn.disabled = false; statusEl.textContent = ''; };
}

function showError(el, err) {
  el.classList.remove('hidden');
  const p = err.payload;
  if (p?.ambiguous && Array.isArray(p.candidates)) {
    el.innerHTML = `${esc(err.message.split(':')[0])} — pick one and paste its mint:<br>` +
      p.candidates.map((c) =>
        `<span class="mint">${esc(c.mint)}</span> — ${esc(c.symbol)} · ${esc(c.name)}` +
        ` ${c.verified ? '' : '<b>(unverified)</b>'}`,
      ).join('<br>');
  } else {
    el.textContent = err.message;
  }
}

/* ---------------------------------------------------------------- plan ---- */

let lastPlanInput = null;

function renderPlan(r) {
  const costPct = r.totalUsd > 0 ? (r.feeUsd + r.impactUsd) / r.totalUsd : 0;
  $('plan-stats').innerHTML = [
    ['Deployed', usd(r.totalUsd), `${usd(r.budgetUsd)} × ${r.periods} ${esc(r.cadence)}`],
    ['Venue fee', usd(r.feeUsd), ''],
    ['Price impact', usd(r.impactUsd), 'measured, not modelled'],
    ['Total cost', usd(r.feeUsd + r.impactUsd), `${pct(costPct, 2)} of capital`],
  ].map(([k, v, s]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}` +
    (s ? ` <small>${s}</small>` : '') + `</div></div>`,
  ).join('');

  $('plan-legs').innerHTML = r.legs.map((l) => {
    const findings = l.audit.findings.map((f) =>
      `<li><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span><span>${esc(f.message)}</span></li>`,
    ).join('') || '<li class="muted" style="border:0">no findings</li>';

    const fit = Number.isFinite(l.exponent)
      ? `exponent ${l.exponent.toFixed(2)}, R² ${l.rSquared.toFixed(2)}` +
        (l.rSquared < 0.8 ? ' <span class="unreliable">— unreliable</span>' : '')
      : 'curve too flat to fit';

    return `<div class="leg">
      <div class="leg-head">
        <span class="sym">${esc(l.symbol)}</span>
        <span class="verdict ${esc(l.audit.verdict)}">${esc(l.audit.verdict)}</span>
        <span class="nm">${esc(l.name)}</span>
      </div>
      <div class="mint">${esc(l.mint)}</div>
      <div class="measure">
        <div>spend <b>${esc(usd(l.spendPerPeriodUsd))}</b>/period → <b>${esc(usd(l.legTotalUsd))}</b> over ${esc(r.periods)}</div>
        <div>impact at size <b>${esc(pct(l.decision.impactIfSingle))}</b> <span class="muted">(${fit})</span></div>
        <div>slicing <b>${l.decision.parts === 1 ? 'none' : esc(l.decision.parts + ' parts')}</b> — ${esc(l.decision.reason)}</div>
        <div class="muted">route ${esc(l.route.join(' › ') || 'n/a')}</div>
      </div>
      <ul class="findings">${findings}</ul>
    </div>`;
  }).join('');

  $('plan-note').textContent =
    `First buy ${r.schedule[0]}, last ${r.schedule[r.schedule.length - 1]}. ` +
    `Funding ${r.fundingSymbol} on ${r.venue}. Impact is measured at today's liquidity and will drift over a multi-year plan.`;

  $('results').classList.remove('hidden');
  $('orders').classList.toggle('hidden', r.blocked > 0);
  if (r.blocked > 0) {
    showError($('plan-error'), new Error(
      `${r.blocked} token(s) blocked by the audit. Resolve those before building orders.`,
    ));
  }
}

$('analyse').addEventListener('click', async () => {
  const done = busy($('analyse'), $('plan-status'), 'measuring live quotes…');
  $('plan-error').classList.add('hidden');
  $('emit').classList.add('hidden');
  $('emit-out').innerHTML = '';
  try {
    lastPlanInput = {
      legs: $('legs').value,
      budget: $('budget').value,
      cadence: $('cadence').value,
      periods: Number($('periods').value),
      slippageBps: Number($('slippage').value),
    };
    renderPlan(await post('/api/plan', lastPlanInput));
  } catch (err) {
    showError($('plan-error'), err);
    $('results').classList.add('hidden');
    $('orders').classList.add('hidden');
  } finally { done(); }
});

/* --------------------------------------------------------------- orders --- */

let specs = [];

function renderOrders(o) {
  specs = o.specs;
  const rows = o.specs.map((s, i) =>
    `<tr><td>${esc(s.leg)}</td><td>${esc(s.depositUsdc)} USDC</td><td>${esc(s.numberOfOrders)} orders</td>` +
    `<td>${s.startAt ? esc(new Date(s.startAt * 1000).toISOString().slice(0, 10)) : 'immediately'}</td>` +
    `<td><button class="ghost" data-emit="${i}">Vet &amp; build</button></td></tr>`,
  ).join('');

  const escrow = o.escrowsUpfront
    ? `<div class="notice"><strong>${esc(usd(o.escrowNowUsd))} is escrowed the moment you sign</strong>
        of ${esc(usd(o.totalUsd))} across the whole plan. It stays yours and cancelling returns it,
        but it is committed from today.</div>`
    : `<p class="hint">This venue draws each part as it executes; nothing is locked up front.</p>`;

  const drift = o.driftDays
    ? `<div class="notice"><strong>Buys cannot be pinned to a calendar date</strong>
        This venue schedules by fixed ${Math.round(o.specs[0].intervalSeconds / 86400)}-day intervals,
        so over ${esc(lastPlanInput.periods)} orders they drift about ${esc(o.driftDays)} days earlier.
        For averaging the date is immaterial — but it is not what "the 1st" means.</div>`
    : '';

  $('order-out').innerHTML = escrow + drift +
    `<table class="specs"><thead><tr><th>Leg</th><th>Deposit</th><th>Schedule</th><th>Starts</th><th></th></tr></thead>
     <tbody>${rows}</tbody></table>`;

  for (const btn of $('order-out').querySelectorAll('[data-emit]')) {
    btn.addEventListener('click', () => emitSpec(Number(btn.dataset.emit)));
  }
}

$('build').addEventListener('click', async () => {
  if (!lastPlanInput) return;
  const done = busy($('build'), $('order-status'), 'validating with the venue…');
  $('order-error').classList.add('hidden');
  try {
    renderOrders(await post('/api/order', {
      ...lastPlanInput,
      wallet: $('wallet').value.trim(),
      chunk: $('chunk').value.trim(),
      validate: $('validate').checked,
    }));
  } catch (err) {
    showError($('order-error'), err);
    $('order-out').innerHTML = '';
  } finally { done(); }
});

/* ----------------------------------------------------------------- emit --- */

async function emitSpec(index) {
  const spec = specs[index];
  if (!spec) return;
  $('emit').classList.remove('hidden');
  $('emit-out').innerHTML = `<p class="muted"><span class="spinner"></span> building and simulating ${esc(spec.leg)}…</p>`;
  $('emit').scrollIntoView({ behavior: 'smooth', block: 'start' });

  let r;
  try {
    r = await post('/api/emit', { spec, check: true });
  } catch (err) {
    $('emit-out').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }

  const checks = r.checks.map((c) =>
    `<li><span class="mark ${esc(c.status)}">${esc(c.status)}</span><span>${esc(c.label)}</span></li>` +
    (c.logs?.length ? `<pre class="logs">${c.logs.map(esc).join('\n')}</pre>` : ''),
  ).join('');

  const blocked = r.blocking > 0;
  $('emit-out').innerHTML = `
    <div class="leg">
      <div class="leg-head">
        <span class="sym">${esc(spec.leg)}</span>
        <span class="nm">${esc(spec.depositUsdc)} USDC over ${esc(spec.numberOfOrders)} orders</span>
      </div>
      <div class="measure"><div class="muted">calls ${esc(r.programs.join(', '))} · rpc ${esc(r.rpcHost)}</div></div>
      <ul class="checks">${checks}</ul>
      ${blocked ? `<div class="notice fail"><strong>${esc(r.blocking)} blocking problem(s)</strong>
          Signing this would burn a fee to land a failure. Fix the above and build again.</div>` : ''}
      <pre class="tx" id="txbox">${esc(r.transaction)}</pre>
      <div class="actions">
        <button id="copytx" class="ghost">Copy transaction</button>
        <button id="signtx" ${blocked ? 'disabled' : ''}>Sign in wallet</button>
        <span id="sign-status" class="muted"></span>
      </div>
      <p class="hint">Expires in about 90 seconds. If it lapses, press <b>Vet &amp; build</b> again — nothing is stored.</p>
    </div>`;

  $('copytx').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(r.transaction);
      $('sign-status').textContent = 'copied';
    } catch {
      // Clipboard needs a secure context or permission; selecting is the fallback.
      const range = document.createRange();
      range.selectNodeContents($('txbox'));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      $('sign-status').textContent = 'selected — copy with your keyboard';
    }
  });

  $('signtx').addEventListener('click', () => signWithWallet(r.transaction));
}

/**
 * Hand the transaction to an injected Solana wallet.
 *
 * Kept as a convenience on top of the copy path rather than the only route: an
 * injected provider may be absent, locked, or on a different network, and the
 * copy path works regardless. This has NOT been exercised against a real
 * wallet -- see the README.
 */
async function signWithWallet(txBase64) {
  const status = $('sign-status');
  const provider = window.solana ?? window.phantom?.solana;
  if (!provider?.isPhantom && !provider?.connect) {
    status.innerHTML = 'No Solana wallet detected in this browser — use <b>Copy transaction</b> and paste it into your wallet.';
    return;
  }
  try {
    status.innerHTML = '<span class="spinner"></span> waiting for your wallet…';
    await provider.connect();
    // Base58-encode the serialised transaction, which is what the provider's
    // low-level request form expects.
    const bytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
    const res = await provider.request({
      method: 'signAndSendTransaction',
      params: { message: base58(bytes) },
    });
    const sig = res?.signature ?? res;
    status.innerHTML = `submitted — <a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(String(sig).slice(0, 16))}…</a>`;
  } catch (err) {
    status.textContent = `wallet declined or failed: ${err?.message ?? err}`;
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  let lead = 0;
  while (lead < bytes.length && bytes[lead] === 0) lead++;
  return '1'.repeat(lead) + out;
}
