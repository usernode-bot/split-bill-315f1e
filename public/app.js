// Split Bill — frontend. Vanilla JS, pathname routing:
//   /          bill list
//   /bill/:id  bill detail with per-person mark-paid toggles
//   /add       add-bill form
// The iframe injects ?token= on load; every fetch forwards it as a header.
// In staging previews ?demo=1 adds example bills (negative ids) served by
// the server without touching the database, so testers see a populated UI.

(function () {
  'use strict';

  var initialParams = new URLSearchParams(window.location.search);
  var TOKEN = initialParams.get('token') || '';
  var DEMO = initialParams.get('demo') === '1';

  var view = document.getElementById('view');
  var titleEl = document.getElementById('app-title');
  var backBtn = document.getElementById('back-btn');
  var footerEl = document.getElementById('footer');
  var footerActions = document.getElementById('footer-actions');

  var state = { billId: null, detail: null, payer: null };

  // Shared class strings — kept as whole literals so the Tailwind compiler
  // (a regex over this file) picks every one of them up.
  var CLS = {
    card: 'rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900',
    btnPrimary: 'w-full h-12 rounded-xl bg-violet-600 text-white font-semibold text-base active:scale-95 transition-transform disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
    lbl: 'block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5',
    inp: 'w-full h-12 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-base text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
    err: 'mt-1.5 text-sm text-red-600 dark:text-red-400',
    hint: 'mt-1.5 text-xs text-zinc-500 dark:text-zinc-400',
    muted: 'text-zinc-500 dark:text-zinc-400',
    badge: 'inline-flex items-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300 text-xs font-medium px-2.5 py-1',
    badgeSettled: 'inline-flex items-center rounded-full bg-violet-600 text-white text-xs font-medium px-2.5 py-1',
    chipOn: 'rounded-full px-3 py-1.5 text-sm font-medium bg-violet-600 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
    chipOff: 'rounded-full px-3 py-1.5 text-sm font-medium bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
    avatar: 'w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 text-sm font-semibold flex items-center justify-center shrink-0',
  };

  var fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function money(cents) { return fmtMoney.format((cents || 0) / 100); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }

  function initial(name) {
    var ch = String(name || '').trim().charAt(0);
    return ch ? ch.toUpperCase() : '?';
  }

  function apiUrl(path) {
    if (!DEMO) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'demo=1';
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'x-usernode-token': TOKEN };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(apiUrl(path), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed (' + res.status + ')');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function showToast(msg) {
    var el = document.getElementById('toast');
    document.getElementById('toast-text').textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
  }

  function showErr(id) { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
  function hideErr(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }

  // "42", "42.5", "42.75" (and a leading $) are amounts; the rest are not.
  function amountToCents(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().replace(/^\$/, '');
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    var cents = parseInt(m[1], 10) * 100 + (m[2] ? parseInt((m[2] + '00').slice(0, 2), 10) : 0);
    if (cents <= 0 || cents > 100000000) return null;
    return cents;
  }

  function parseParticipants(raw) {
    var seen = {};
    var out = [];
    String(raw || '').split(',').forEach(function (part) {
      var name = part.trim().replace(/\s+/g, ' ');
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(name);
    });
    return out;
  }

  function containsName(names, key) {
    return names.some(function (n) { return n.toLowerCase() === key; });
  }

  // ---- chrome ----

  function setChrome(title, showBack, footerHtml) {
    titleEl.textContent = title;
    backBtn.classList.toggle('hidden', !showBack);
    if (footerHtml) {
      footerActions.innerHTML = footerHtml;
      footerEl.classList.remove('hidden');
    } else {
      footerActions.innerHTML = '';
      footerEl.classList.add('hidden');
    }
  }

  function navigate(path) {
    history.pushState({}, '', path);
    route();
  }

  function route() {
    var m = /^\/bill\/(-?\d+)\/?$/.exec(window.location.pathname);
    if (window.location.pathname === '/add') renderAdd();
    else if (m) renderDetail(parseInt(m[1], 10));
    else renderList();
  }

  // ---- bill list ----

  function demoBanner() {
    return '<div class="mb-3 rounded-xl border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10 px-3 py-2 text-xs text-violet-700 dark:text-violet-300">'
      + 'Preview data. Bills marked "Staging demo" are examples and are not saved.</div>';
  }

  function billCard(b) {
    var owed = b.owed_count || 0;
    var paid = b.paid_count || 0;
    var badge = owed > 0 && paid === owed
      ? '<span class="' + CLS.badgeSettled + '">Settled</span>'
      : '<span class="' + CLS.badge + '">' + paid + ' of ' + owed + ' paid</span>';
    return '<a data-nav href="/bill/' + b.id + '" class="bill-card block ' + CLS.card + ' p-4">'
      + '<div class="flex items-start justify-between gap-3">'
      + '<h3 class="font-semibold leading-snug min-w-0">' + esc(b.title) + '</h3>'
      + '<span class="font-semibold tabular-nums shrink-0">' + money(b.total_cents) + '</span>'
      + '</div>'
      + '<p class="mt-1 text-sm ' + CLS.muted + '">Paid by ' + esc(b.payer) + ' · ' + fmtDate(b.created_at) + '</p>'
      + '<div class="mt-3">' + badge + '</div>'
      + '</a>';
  }

  function renderList() {
    state.detail = null;
    setChrome('Split Bill', false,
      '<button type="button" data-action="add" class="' + CLS.btnPrimary + '">Add bill</button>');
    view.innerHTML = '<div class="space-y-3">'
      + '<div class="' + CLS.card + ' p-4"><div class="h-5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800"></div><div class="mt-2 h-4 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800"></div></div>'
      + '<div class="' + CLS.card + ' p-4"><div class="h-5 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800"></div><div class="mt-2 h-4 w-1/3 rounded bg-zinc-200 dark:bg-zinc-800"></div></div>'
      + '</div>';
    api('/api/bills').then(function (data) {
      var bills = data.bills || [];
      if (!bills.length) {
        view.innerHTML = '<div class="mt-16 flex flex-col items-center gap-3 text-center">'
          + '<div class="w-12 h-12 rounded-full bg-violet-100 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300 flex items-center justify-center">'
          + '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/></svg>'
          + '</div>'
          + '<p class="font-medium">No bills yet</p>'
          + '<p class="text-sm ' + CLS.muted + '">Add your first bill to start tracking who owes what.</p>'
          + '</div>';
        return;
      }
      view.innerHTML = (DEMO ? demoBanner() : '')
        + '<div class="space-y-3">' + bills.map(billCard).join('') + '</div>';
    }).catch(function (err) {
      view.innerHTML = errorState(err, 'Could not load bills');
    });
  }

  function errorState(err, heading) {
    var detail = err.status === 401
      ? 'Open Split Bill inside Homeroom to see your bills.'
      : err.message;
    return '<div class="mt-16 flex flex-col items-center gap-2 text-center">'
      + '<p class="font-medium">' + esc(heading) + '</p>'
      + '<p class="text-sm ' + CLS.muted + '">' + esc(detail) + '</p>'
      + '</div>';
  }

  // ---- bill detail ----

  function switchHtml(s) {
    var track = s.paid ? 'bg-violet-600' : 'bg-zinc-300 dark:bg-zinc-700';
    var knob = s.paid ? 'translate-x-5' : 'translate-x-0.5';
    return '<button type="button" data-action="toggle" data-share="' + s.id + '" role="switch"'
      + ' aria-checked="' + (s.paid ? 'true' : 'false') + '"'
      + ' aria-label="Mark ' + esc(s.username) + ' as paid"'
      + ' class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ' + track
      + ' focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500">'
      + '<span class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' + knob + '"></span>'
      + '</button>';
  }

  function shareRow(s) {
    var row = '<div class="flex items-center gap-3 p-4">'
      + '<span class="' + CLS.avatar + '">' + esc(initial(s.username)) + '</span>'
      + '<div class="flex-1 min-w-0">'
      + '<p class="font-medium truncate">' + esc(s.username) + '</p>'
      + '<p class="text-sm ' + CLS.muted + '">';
    if (s.is_payer) row += 'paid the bill';
    else if (s.paid) row += 'settled up';
    else row += 'owes ' + money(s.share_cents);
    row += '</p></div>';
    if (s.is_payer) {
      row += '<span class="text-sm tabular-nums ' + CLS.muted + '">' + money(s.share_cents) + '</span>';
    } else {
      row += switchHtml(s);
    }
    return row + '</div>';
  }

  function drawDetail() {
    var d = state.detail;
    var bill = d.bill;
    var shares = d.shares;
    var owed = shares.filter(function (s) { return !s.is_payer; });
    var remaining = owed.filter(function (s) { return !s.paid; })
      .reduce(function (t, s) { return t + s.share_cents; }, 0);
    var summary = remaining === 0
      ? '<span class="' + CLS.badgeSettled + '">All settled up</span>'
      : '<p class="text-sm ' + CLS.muted + '">Still owed to '
        + '<span class="font-medium text-zinc-900 dark:text-zinc-100">' + esc(bill.payer) + '</span>: '
        + '<span class="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">' + money(remaining) + '</span></p>';

    view.innerHTML = '<div class="' + CLS.card + ' p-5">'
      + '<h2 class="text-base font-semibold leading-snug">' + esc(bill.title) + '</h2>'
      + '<div class="mt-2 text-3xl font-bold tracking-tight tabular-nums">' + money(bill.total_cents) + '</div>'
      + '<p class="mt-1 text-sm ' + CLS.muted + '">Paid by ' + esc(bill.payer) + ' · ' + fmtDate(bill.created_at) + '</p>'
      + '<p class="text-xs ' + CLS.muted + '">Split equally between ' + shares.length + ' people</p>'
      + '<div class="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">' + summary + '</div>'
      + '</div>'
      + '<div class="mt-4 ' + CLS.card + ' divide-y divide-zinc-100 dark:divide-zinc-800">'
      + shares.map(shareRow).join('')
      + '</div>'
      + (DEMO ? '<div class="mt-3 text-xs text-center ' + CLS.muted + '">Preview bill, changes are not saved.</div>' : '');
  }

  function renderDetail(id) {
    state.billId = id;
    state.detail = null;
    setChrome('Bill', true, '');
    view.innerHTML = '<p class="text-sm ' + CLS.muted + '">Loading…</p>';
    api('/api/bills/' + id).then(function (data) {
      state.detail = data;
      drawDetail();
    }).catch(function (err) {
      view.innerHTML = errorState(err, 'Could not load this bill');
    });
  }

  function toggleShare(btn) {
    var shareId = parseInt(btn.getAttribute('data-share'), 10);
    btn.disabled = true;
    api('/api/bills/' + state.billId + '/shares/' + shareId + '/toggle', { method: 'POST' })
      .then(function (data) {
        var shares = state.detail.shares;
        for (var i = 0; i < shares.length; i++) {
          if (shares[i].id === data.share.id) shares[i] = data.share;
        }
        drawDetail();
      })
      .catch(function (err) {
        btn.disabled = false;
        showToast(err.message);
      });
  }

  // ---- add bill ----

  function formHtml() {
    return '<form id="add-form" novalidate class="flex flex-col gap-5">'
      + '<div>'
      + '<label for="f-title" class="' + CLS.lbl + '">Title</label>'
      + '<input id="f-title" type="text" maxlength="200" autocomplete="off" placeholder="Pizza night" class="' + CLS.inp + '">'
      + '<p id="e-title" class="' + CLS.err + ' hidden">Title needs at least 3 characters.</p>'
      + '</div>'
      + '<div>'
      + '<label for="f-amount" class="' + CLS.lbl + '">Amount</label>'
      + '<div class="relative">'
      + '<span class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400">$</span>'
      + '<input id="f-amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" class="' + CLS.inp + ' pl-7">'
      + '</div>'
      + '<p id="e-amount" class="' + CLS.err + ' hidden">Enter an amount greater than zero.</p>'
      + '</div>'
      + '<div>'
      + '<label for="f-people" class="' + CLS.lbl + '">Friends</label>'
      + '<input id="f-people" type="text" autocomplete="off" placeholder="Alex, Sam, Jordan" class="' + CLS.inp + '">'
      + '<p class="' + CLS.hint + '">Separate names with commas. Everyone splits equally.</p>'
      + '<p id="e-people" class="' + CLS.err + ' hidden">Add at least two friends.</p>'
      + '<div id="payer-picker" class="mt-3"></div>'
      + '<p id="e-payer" class="' + CLS.err + ' hidden">Pick who paid.</p>'
      + '</div>'
      + '</form>';
  }

  function drawPayerPicker(names) {
    var el = document.getElementById('payer-picker');
    if (!names.length) {
      el.innerHTML = '<p class="' + CLS.lbl + '">Paid by</p>'
        + '<p class="' + CLS.hint + ' mb-0">Type names above to choose who paid.</p>';
      return;
    }
    el.innerHTML = '<p class="' + CLS.lbl + '">Paid by</p>'
      + '<div class="flex flex-wrap gap-2">'
      + names.map(function (n) {
          var on = n.toLowerCase() === state.payer;
          return '<button type="button" data-action="pick-payer" data-name="' + esc(n.toLowerCase())
            + '" class="' + (on ? CLS.chipOn : CLS.chipOff) + '">' + esc(n) + '</button>';
        }).join('')
      + '</div>';
  }

  function renderAdd() {
    state.payer = null;
    setChrome('Add bill', true,
      '<button type="button" data-action="submit-add" class="' + CLS.btnPrimary + '">Save bill</button>');
    view.innerHTML = formHtml();
    var peopleInput = document.getElementById('f-people');
    peopleInput.addEventListener('input', function () {
      var names = parseParticipants(peopleInput.value);
      if (!names.length) state.payer = null;
      else if (!state.payer || !containsName(names, state.payer)) state.payer = names[0].toLowerCase();
      drawPayerPicker(names);
      hideErr('e-people');
      hideErr('e-payer');
    });
    drawPayerPicker([]);
    document.getElementById('f-title').addEventListener('input', function () { hideErr('e-title'); });
    document.getElementById('f-amount').addEventListener('input', function () { hideErr('e-amount'); });
    document.getElementById('add-form').addEventListener('submit', submitAdd);
  }

  function submitAdd(e) {
    e.preventDefault();
    var title = document.getElementById('f-title').value.trim();
    var amountRaw = document.getElementById('f-amount').value;
    var names = parseParticipants(document.getElementById('f-people').value);

    var ok = true;
    if (title.length < 3) { showErr('e-title'); ok = false; } else hideErr('e-title');
    if (amountToCents(amountRaw) === null) { showErr('e-amount'); ok = false; } else hideErr('e-amount');
    if (names.length < 2) { showErr('e-people'); ok = false; } else hideErr('e-people');
    if (names.length >= 2 && !state.payer) { showErr('e-payer'); ok = false; } else hideErr('e-payer');
    if (!ok) return;

    var btn = footerActions.querySelector('button');
    if (btn) btn.disabled = true;
    api('/api/bills', {
      method: 'POST',
      body: { title: title, amount: amountRaw, payer: state.payer, participants: names },
    }).then(function (data) {
      navigate('/bill/' + data.bill.id + (DEMO ? '?demo=1' : ''));
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      showToast(err.message);
    });
  }

  // ---- events ----

  document.addEventListener('click', function (e) {
    var navEl = e.target.closest('[data-nav]');
    if (navEl) {
      e.preventDefault();
      navigate(navEl.getAttribute('href'));
      return;
    }
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'add') navigate('/add' + (DEMO ? '?demo=1' : ''));
    else if (action === 'back') navigate('/');
    else if (action === 'toggle') toggleShare(el);
    else if (action === 'submit-add') {
      var form = document.getElementById('add-form');
      if (form) form.requestSubmit();
    } else if (action === 'pick-payer') {
      state.payer = el.getAttribute('data-name');
      drawPayerPicker(parseParticipants(document.getElementById('f-people').value));
      hideErr('e-payer');
    }
  });

  window.addEventListener('popstate', route);
  route();
})();