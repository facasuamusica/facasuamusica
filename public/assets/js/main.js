/* ============================================================
   Faça Sua Música — comportamento da landing page
   ============================================================ */
(function () {
  'use strict';

  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ---------- header ---------- */
  var header = $('#header');
  var onScroll = function () {
    header.classList.toggle('is-stuck', window.scrollY > 8);
    stickyCtaUpdate();
    revealSweep();
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- menu mobile ---------- */
  var burger = $('#burger');
  var nav = $('#nav');
  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
  });
  $$('a', nav).forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });

  /* ---------- player de áudio ----------
     As amostras reais devem ficar em assets/audio/.
     Enquanto o arquivo não existir, o player entra em modo demonstração
     para que o layout continue avaliável. */
  var audio = $('#audio');
  var card = $('[data-player-card]');
  var cardTitle = $('[data-player-title]');
  var cardMeta = $('[data-player-meta]');
  var fill = $('[data-progress-fill]');
  var progressWrap = $('[data-progress-wrap]');
  var timeCurrent = $('[data-time-current]');
  var timeTotal = $('[data-time-total]');

  var current = null;          // botão ativo
  var demoTimer = null;        // modo demonstração
  var demoPos = 0;
  var DEMO_DURATION = 32;

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function paint(pos, total) {
    fill.style.width = (total ? (pos / total) * 100 : 0) + '%';
    timeCurrent.textContent = fmt(pos);
    timeTotal.textContent = fmt(total);
  }

  function setActive(btn) {
    $$('.play-btn').forEach(function (b) { b.classList.toggle('is-playing', b === btn); });
    $$('.sample').forEach(function (s) { s.classList.toggle('is-active', !!btn && s.contains(btn)); });
    card.classList.toggle('is-playing', !!btn);
    if (btn) {
      cardTitle.textContent = btn.getAttribute('data-title') || '';
      cardMeta.textContent = btn.getAttribute('data-meta') || '';
    }
  }

  function stopDemo() {
    if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  }

  function startDemo() {
    stopDemo();
    demoTimer = setInterval(function () {
      demoPos += 0.25;
      if (demoPos >= DEMO_DURATION) { stopAll(); return; }
      paint(demoPos, DEMO_DURATION);
    }, 250);
  }

  function stopAll() {
    stopDemo();
    audio.pause();
    current = null;
    demoPos = 0;
    setActive(null);
    paint(0, 0);
  }

  function play(btn) {
    var src = btn.getAttribute('data-play');

    if (current === btn) {                       // pausar o que está tocando
      if (demoTimer) { stopDemo(); setActive(null); card.classList.remove('is-playing'); btn.classList.remove('is-playing'); }
      else { audio.pause(); btn.classList.remove('is-playing'); card.classList.remove('is-playing'); }
      current = null;
      return;
    }

    stopDemo();
    current = btn;
    setActive(btn);
    demoPos = 0;

    audio.src = src;
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () { startDemo(); });     // arquivo ausente ou bloqueado
    }
  }

  $$('.play-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { play(btn); });
  });

  audio.addEventListener('timeupdate', function () { paint(audio.currentTime, audio.duration); });
  audio.addEventListener('loadedmetadata', function () { paint(0, audio.duration); });
  audio.addEventListener('ended', stopAll);
  audio.addEventListener('error', function () { if (current) startDemo(); });

  progressWrap.addEventListener('click', function (e) {
    var rect = progressWrap.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (demoTimer) { demoPos = ratio * DEMO_DURATION; paint(demoPos, DEMO_DURATION); }
    else if (audio.duration) { audio.currentTime = ratio * audio.duration; }
  });

  /* ---------- filtro de amostras ---------- */
  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var filter = tab.getAttribute('data-filter');
      $$('.tab').forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      $$('.sample').forEach(function (s) {
        var genres = s.getAttribute('data-genre') || '';
        s.classList.toggle('is-hidden', filter !== 'todos' && genres.indexOf(filter) === -1);
      });
    });
  });

  /* ---------- FAQ: abre um por vez ---------- */
  var faqItems = $$('.faq__item');
  faqItems.forEach(function (item) {
    item.addEventListener('toggle', function () {
      if (!item.open) return;
      faqItems.forEach(function (other) { if (other !== item) other.open = false; });
    });
  });

  /* ---------- contadores ---------- */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var suffix = el.getAttribute('data-suffix') || '';
    var start = performance.now();
    var duration = 1400;

    (function tick(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = target * eased;
      el.textContent = (decimals ? value.toFixed(decimals) : Math.round(value).toLocaleString('pt-BR')) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    })(start);
  }

  /* ---------- reveal + contadores ----------
     Varredura no scroll em vez de IntersectionObserver: links âncora podem
     pular seções inteiras, e um observer nunca reporta quem não chegou a
     cruzar a viewport — essas seções ficariam invisíveis para sempre. */
  var revealTargets = $$('.section__head, .step, .card, .plan, .testimonial, .player-card, .faq__item, .final-cta__inner');
  revealTargets.forEach(function (el) { el.setAttribute('data-reveal', ''); });

  var pending = revealTargets.slice();
  var statsEl = $('.stats');
  var statsDone = false;

  function revealSweep() {
    var limit = window.innerHeight - 40;
    pending = pending.filter(function (el) {
      if (el.getBoundingClientRect().top >= limit) return true;
      el.classList.add('is-visible');
      return false;
    });
    if (!statsDone && statsEl && statsEl.getBoundingClientRect().top < window.innerHeight * 0.85) {
      statsDone = true;
      $$('[data-count]', statsEl).forEach(animateCount);
    }
  }

  window.addEventListener('resize', revealSweep, { passive: true });
  window.addEventListener('load', revealSweep);
  window.addEventListener('hashchange', function () { setTimeout(revealSweep, 60); });

  /* ---------- sticky cta ---------- */
  var sticky = $('#stickyCta');
  var precos = $('#precos');
  function stickyCtaUpdate() {
    if (!sticky) return;
    var past = window.scrollY > window.innerHeight * 0.8;
    var overPricing = precos && precos.getBoundingClientRect().top < window.innerHeight && precos.getBoundingClientRect().bottom > 0;
    var show = past && !overPricing;
    sticky.hidden = false;
    sticky.classList.toggle('is-visible', show);
  }

  /* ---------- checkout ---------- */

  var PACOTE_DO_PLANO = { essencial: 'p1', especial: 'p3', eterno: 'p7' };

  var checkoutModal = $('#checkoutModal');
  var checkoutForm = $('#checkoutForm');
  var pacoteEscolhido = null;
  var pacotesDoServidor = null;

  function dinheiro(centavos) {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  // O preço vem do servidor: a página nunca decide quanto custa, senão
  // bastaria editar o HTML para comprar 7 créditos por um centavo.
  function rotuloDoPacote(id) {
    var pedir = pacotesDoServidor
      ? Promise.resolve(pacotesDoServidor)
      : fetch('/api/pacotes').then(function (r) { return r.json(); }).then(function (lista) {
          pacotesDoServidor = lista;
          return lista;
        });

    return pedir.then(function (lista) {
      var p = (lista || []).filter(function (x) { return x.id === id; })[0];
      if (!p) return '';
      return p.creditos + (p.creditos === 1 ? ' música' : ' músicas') + ' · ' + dinheiro(p.valorCentavos);
    }).catch(function () { return ''; });
  }

  function abrirCheckout(plano) {
    pacoteEscolhido = PACOTE_DO_PLANO[plano] || plano;
    $('#checkoutErro').textContent = '';
    checkoutModal.hidden = false;
    document.body.style.overflow = 'hidden';
    rotuloDoPacote(pacoteEscolhido).then(function (t) {
      $('#checkoutPacote').textContent = t || 'Seu pacote';
    });
    setTimeout(function () { checkoutForm.elements.nome.focus(); }, 60);
  }

  function fecharCheckout() {
    checkoutModal.hidden = true;
    document.body.style.overflow = '';
  }

  $$('[data-plan]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      abrirCheckout(btn.getAttribute('data-plan'));
    });
  });

  $$('[data-fechar-checkout]').forEach(function (el) {
    el.addEventListener('click', fecharCheckout);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && checkoutModal && !checkoutModal.hidden) fecharCheckout();
  });

  // Máscara leve: a pessoa vê (11) 91234-5678 enquanto digita, e o servidor
  // normaliza de novo do lado de lá.
  checkoutForm.elements.whatsapp.addEventListener('input', function (e) {
    var d = e.target.value.replace(/\D/g, '').slice(0, 11);
    var saida = d;
    if (d.length > 7) saida = '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    else if (d.length > 2) saida = '(' + d.slice(0, 2) + ') ' + d.slice(2);
    e.target.value = saida;
  });

  $('#btPagar').addEventListener('click', function () {
    var campos = checkoutForm.elements;
    var nome = campos.nome.value.trim();
    var whatsapp = campos.whatsapp.value.trim();
    var email = campos.email.value.trim();
    var erro = $('#checkoutErro');

    erro.textContent = '';

    if (nome.split(/\s+/).length < 2) {
      erro.textContent = 'Escreva seu nome completo, com sobrenome.';
      campos.nome.focus();
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      erro.textContent = 'Confira o e-mail — é por ele que o link da música chega.';
      campos.email.focus();
      return;
    }
    if (whatsapp.replace(/\D/g, '').length !== 11) {
      erro.textContent = 'Informe DDD e celular, como (11) 91234-5678.';
      campos.whatsapp.focus();
      return;
    }

    var bt = $('#btPagar');
    bt.disabled = true;
    bt.textContent = 'Abrindo o pagamento…';

    fetch('/api/pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nome, email: email, whatsapp: whatsapp, pacote: pacoteEscolhido })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Não conseguimos abrir o pagamento.');
        if (!res.d.checkoutUrl) throw new Error('O pagamento está indisponível agora. Tente em alguns minutos.');

        // Guarda o link antes de sair da página: se a pessoa desistir no
        // Mercado Pago, ainda consegue voltar ao pedido dela.
        try { localStorage.setItem('fsm_ultimo_pedido', res.d.acompanhe); } catch (e) {}

        window.location.href = res.d.checkoutUrl;
      })
      .catch(function (e) {
        erro.textContent = e.message;
        bt.disabled = false;
        bt.textContent = 'Ir para o pagamento';
      });
  });

  /* ---------- briefing multi-etapas ---------- */
  var modal = $('#briefing');
  var form = $('#briefingForm');
  var panels = $$('.step-panel', form);
  var btnNext = $('[data-step-next]');
  var btnBack = $('[data-step-back]');
  var stepCurrent = $('[data-step-current]');
  var stepProgress = $('[data-step-progress]');
  var stepTitle = $('[data-step-title]');
  var DRAFT_KEY = 'fsm_briefing';
  var stepIndex = 0;
  var lastFocus = null;

  $('[data-step-total]').textContent = String(panels.length);

  var LABELS = {
    ocasiao: 'Ocasião', destinatario: 'Para', apelido: 'Apelido', remetente: 'De',
    relacao: 'Relação', historia: 'História', data: 'Data', lugar: 'Lugar',
    genero: 'Estilo', voz: 'Voz', clima: 'Clima', obrigatorio: 'Não pode faltar',
    evitar: 'Evitar', email: 'E-mail', whatsapp: 'WhatsApp'
  };

  function readForm() {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (String(value).trim()) data[key] = String(value).trim();
    });
    return data;
  }

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(readForm())); } catch (e) {}
  }

  function restoreDraft() {
    var raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    Object.keys(data).forEach(function (key) {
      var field = form.elements[key];
      if (!field) return;
      if (field instanceof RadioNodeList || (field.length && !field.tagName)) {
        $$('input[name="' + key + '"]', form).forEach(function (input) {
          if (input.value === data[key]) input.checked = true;
        });
      } else {
        field.value = data[key];
      }
    });
    updateCounters();
  }

  function clearError(el) {
    el.classList.remove('is-invalid');
    var msg = el.parentNode && el.parentNode.querySelector ? el.parentNode.querySelector('.field__error') : null;
    if (msg) msg.remove();
    var own = el.querySelector ? el.querySelector('.field__error') : null;
    if (own) own.remove();
  }

  function showError(el, text) {
    el.classList.add('is-invalid');
    if (el.querySelector('.field__error')) return;
    var span = document.createElement('span');
    span.className = 'field__error';
    span.textContent = text;
    el.appendChild(span);
  }

  function validateStep(index) {
    var panel = panels[index];
    var ok = true;
    var firstBad = null;

    $$('[data-required]', panel).forEach(function (group) {
      clearError(group);
      var name = group.getAttribute('data-required');
      if (!$('input[name="' + name + '"]:checked', panel)) {
        showError(group, 'Escolha uma opção para continuar.');
        ok = false;
        firstBad = firstBad || group;
      }
    });

    $$('input[required], select[required], textarea[required]', panel).forEach(function (input) {
      var wrap = input.closest('.field') || input.parentNode;
      clearError(wrap);
      var value = input.value.trim();
      var msg = '';

      if (!value) {
        msg = 'Esse campo é obrigatório.';
      } else if (input.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        msg = 'Digite um e-mail válido.';
      } else if (input.minLength > 0 && value.length < input.minLength) {
        msg = 'Escreva um pouco mais — pelo menos ' + input.minLength + ' caracteres.';
      }

      if (msg) {
        showError(wrap, msg);
        ok = false;
        firstBad = firstBad || input;
      }
    });

    if (firstBad && firstBad.focus) firstBad.focus();
    return ok;
  }

  function buildReview() {
    var list = $('[data-review-list]');
    var data = readForm();
    list.innerHTML = '';
    Object.keys(LABELS).forEach(function (key) {
      if (!data[key]) return;
      var dt = document.createElement('dt');
      dt.textContent = LABELS[key];
      var dd = document.createElement('dd');
      dd.textContent = data[key].length > 140 ? data[key].slice(0, 140) + '…' : data[key];
      list.appendChild(dt);
      list.appendChild(dd);
    });
  }

  function goToStep(index) {
    stepIndex = Math.max(0, Math.min(panels.length - 1, index));
    panels.forEach(function (p, i) { p.classList.toggle('is-active', i === stepIndex); });

    stepCurrent.textContent = String(stepIndex + 1);
    stepTitle.textContent = panels[stepIndex].getAttribute('data-title');
    stepProgress.style.width = ((stepIndex + 1) / panels.length * 100) + '%';

    btnBack.style.visibility = stepIndex === 0 ? 'hidden' : 'visible';
    btnNext.textContent = stepIndex === panels.length - 1 ? 'Ver pacotes e finalizar' : 'Continuar';

    if (stepIndex === panels.length - 1) buildReview();
    $('.modal__body').scrollTop = 0;

    var firstField = panels[stepIndex].querySelector('input:not([type=radio]), select, textarea');
    if (firstField && window.innerWidth > 620) firstField.focus();
  }

  function openBriefing() {
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('is-locked');
    restoreDraft();
    goToStep(0);
  }

  function closeBriefing() {
    saveDraft();
    modal.hidden = true;
    document.body.classList.remove('is-locked');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function finishBriefing() {
    saveDraft();
    closeBriefing();
    var precosEl = $('#precos');
    if (precosEl) precosEl.scrollIntoView({ behavior: 'smooth' });
    setTimeout(revealSweep, 700);
  }

  $$('[data-open-briefing]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); openBriefing(); });
  });
  $$('[data-close-briefing]').forEach(function (el) {
    el.addEventListener('click', closeBriefing);
  });

  btnNext.addEventListener('click', function () {
    if (!validateStep(stepIndex)) return;
    saveDraft();
    if (stepIndex === panels.length - 1) finishBriefing();
    else goToStep(stepIndex + 1);
  });
  btnBack.addEventListener('click', function () { goToStep(stepIndex - 1); });

  form.addEventListener('submit', function (e) { e.preventDefault(); btnNext.click(); });
  form.addEventListener('change', function () {
    saveDraft();
    if (stepIndex === panels.length - 1) buildReview();
  });

  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); btnNext.click(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeBriefing();
  });

  /* contador de caracteres */
  function updateCounters() {
    $$('[data-counter-for]').forEach(function (out) {
      var field = form.elements[out.getAttribute('data-counter-for')];
      if (field) out.textContent = String(field.value.trim().length);
    });
  }
  form.addEventListener('input', function () {
    updateCounters();
    if (stepIndex === panels.length - 1) buildReview();
  });

  /* ---------- ano no rodapé ---------- */
  var year = $('[data-year]');
  if (year) year.textContent = new Date().getFullYear();

  onScroll();
})();
