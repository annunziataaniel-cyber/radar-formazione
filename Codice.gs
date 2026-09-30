// RADAR V1.2 - filtri anti-rumore, classificazione/scadenze corrette e deduplica conservativa
const RADAR = {
  FOGLIO_FONTI: 'FONTI_V1',
  FOGLIO_CONFIG: 'CONFIG',
  FOGLIO_OPPORTUNITA: 'OPPORTUNITA',
  FOGLIO_LOG: 'LOG',
  FOGLIO_STATO: 'STATO',

  HEADERS_FONTI: ['BLOCCO', 'AREA', 'ENTE', 'FONTE', 'URL', 'PARSER'],
  HEADERS_OPPORTUNITA: ['DATA', 'AREA', 'TIPO', 'CATEGORIA', 'FONTE', 'TITOLO', 'SCADENZA', 'LINK'],
  HEADERS_LOG: ['DATA/ORA', 'BLOCCO', 'FONTE', 'ESITO', 'DETTAGLIO'],
  HEADERS_STATO: ['DATA/ORA', 'SOURCE_KEY', 'ITEM_KEY', 'HASH', 'TITOLO'],

  BLOCCHI: [
    'B01_SCUOLA',
    'B02_MIM_MUR',
    'B03_CAMPANIA',
    'B04_LAVORO',
    'B05_IMPRESE',
    'B05_DIGITALE',
    'B06_SOCIALE',
    'B07_PA',
    'B08_SALUTE',
    'B09_DIFESA',
    'B10_SETTORI',
    'B11_SPORT',
    'B12_FONDI_A',
    'B13_FONDI_B',
    'B14_FORMATEMP'
  ],

  PARSER_AMMESSI: ['LISTA', 'TABELLA', 'PAGINA', 'SPECIALE_BURC'],

  DEFAULT_CONFIG: [
    ['EMAIL_DESTINATARIO', ''],
    ['ORA_AVVIO', '8'],
    ['MAX_RUNTIME_BLOCCO_SEC', '250'],
    ['GIORNI_LOG', '30'],
    ['MAX_DETTAGLI_PER_FONTE', '8'],
    ['PAUSA_TRA_BLOCCHI_SEC', '10']
  ],

  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/140.0 Safari/537.36',

  PROP_SPREADSHEET_ID: 'RADAR_SPREADSHEET_ID',
  PROP_RUN_ACTIVE: 'RADAR_RUN_ACTIVE',
  PROP_RUN_ID: 'RADAR_RUN_ID',
  PROP_RUN_START_MS: 'RADAR_RUN_START_MS',
  PROP_RUN_BLOCK_INDEX: 'RADAR_RUN_BLOCK_INDEX',
  PROP_RUN_SOURCE_INDEX: 'RADAR_RUN_SOURCE_INDEX',
  PROP_RUN_START_ROW: 'RADAR_RUN_START_ROW',
  PROP_RUN_ERRORS: 'RADAR_RUN_ERRORS',
  PROP_RUN_FETCH_ERRORS: 'RADAR_RUN_FETCH_ERRORS',
  PROP_RUN_SUSPECTS: 'RADAR_RUN_SUSPECTS',
  PROP_RUN_SYSTEM_ERRORS: 'RADAR_RUN_SYSTEM_ERRORS',
  PROP_RUN_ATTEMPTED: 'RADAR_RUN_ATTEMPTED',

  HANDLER_GIORNALIERO: 'avviaRadarGiornaliero',
  HANDLER_BLOCCO: 'eseguiBloccoRadar',

  BASELINE_KEY: '__BASELINE__',
  HASH_VERSION: 'v2'
};


/**
 * Eseguire manualmente una sola volta.
 * Prepara i fogli tecnici, valida FONTI_V1 e crea i trigger feriali.
 */
function setupRadar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Questo script deve essere collegato al foglio Google del radar.');
  }

  PropertiesService.getScriptProperties()
    .setProperty(RADAR.PROP_SPREADSHEET_ID, ss.getId());

  validaFonti_(ss);
  preparaConfig_(ss);
  preparaFoglioConHeaders_(ss, RADAR.FOGLIO_OPPORTUNITA, RADAR.HEADERS_OPPORTUNITA, false);
  preparaFoglioConHeaders_(ss, RADAR.FOGLIO_LOG, RADAR.HEADERS_LOG, false);
  preparaFoglioConHeaders_(ss, RADAR.FOGLIO_STATO, RADAR.HEADERS_STATO, true);

  const shStato = ss.getSheetByName(RADAR.FOGLIO_STATO);
  if (shStato && !shStato.isSheetHidden()) {
    shStato.hideSheet();
  }

  pulisciRunProperties_();
  cancellaTriggerRadar_();
  creaTriggerFeriali_();
  potaLog_();

  scriviLog_('', 'RADAR', 'SETUP', 'Setup completato; FONTI_V1 validato e trigger feriali creati.');
}


/**
 * Avvio automatico del radar. I trigger vengono creati dal lunedì al venerdì.
 * Inizializza la sessione giornaliera e mette in coda il primo blocco.
 */
function avviaRadarGiornaliero() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;

  try {
    const ss = getSpreadsheet_();
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();

    if (props.getProperty(RADAR.PROP_RUN_ACTIVE) === '1') {
      const started = Number(props.getProperty(RADAR.PROP_RUN_START_MS) || 0);
      const ageMs = started ? now - started : Number.MAX_SAFE_INTEGER;

      if (ageMs < 8 * 60 * 60 * 1000) {
        scriviLog_('', 'RADAR', 'SKIP', 'Avvio ignorato: una sessione radar risulta già attiva.');
        return;
      }

      // Sessione evidentemente rimasta appesa da un'esecuzione precedente.
      pulisciRunProperties_();
      cancellaTriggerTemporanei_();
      scriviLog_('', 'RADAR', 'RECUPERO', 'Rimossa una sessione radar precedente rimasta aperta oltre 8 ore.');
    }

    validaFonti_(ss);
    preparaFoglioConHeaders_(ss, RADAR.FOGLIO_OPPORTUNITA, RADAR.HEADERS_OPPORTUNITA, false);
    preparaFoglioConHeaders_(ss, RADAR.FOGLIO_LOG, RADAR.HEADERS_LOG, false);
    preparaFoglioConHeaders_(ss, RADAR.FOGLIO_STATO, RADAR.HEADERS_STATO, true);

    const shOpp = ss.getSheetByName(RADAR.FOGLIO_OPPORTUNITA);
    const runId = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd-HHmmss');

    props.setProperties({
      [RADAR.PROP_RUN_ACTIVE]: '1',
      [RADAR.PROP_RUN_ID]: runId,
      [RADAR.PROP_RUN_START_MS]: String(now),
      [RADAR.PROP_RUN_BLOCK_INDEX]: '0',
      [RADAR.PROP_RUN_SOURCE_INDEX]: '0',
      [RADAR.PROP_RUN_START_ROW]: String(shOpp.getLastRow() + 1),
      [RADAR.PROP_RUN_ERRORS]: '0',
      [RADAR.PROP_RUN_FETCH_ERRORS]: '0',
      [RADAR.PROP_RUN_SUSPECTS]: '0',
      [RADAR.PROP_RUN_SYSTEM_ERRORS]: '0',
      [RADAR.PROP_RUN_ATTEMPTED]: '[]'
    }, false);

    cancellaTriggerTemporanei_();
    programmaProssimoBlocco_(1);
  } finally {
    lock.releaseLock();
  }
}


/**
 * Esegue il blocco corrente. Se si avvicina al limite prudenziale,
 * salva il cursore e mette in coda la prosecuzione dello stesso blocco.
 */
function eseguiBloccoRadar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;

  try {
    cancellaTriggerTemporanei_();

    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(RADAR.PROP_RUN_ACTIVE) !== '1') return;

    const ss = getSpreadsheet_();
    const config = leggiConfig_(ss);
    const startMs = Date.now();
    const maxRuntimeMs = Math.max(120, Number(config.MAX_RUNTIME_BLOCCO_SEC || 250)) * 1000;
    const deadlineMs = startMs + maxRuntimeMs;

    let blockIndex = Number(props.getProperty(RADAR.PROP_RUN_BLOCK_INDEX) || 0);
    let sourceIndex = Number(props.getProperty(RADAR.PROP_RUN_SOURCE_INDEX) || 0);

    if (blockIndex >= RADAR.BLOCCHI.length) {
      finalizzaRadar_();
      return;
    }

    const blocco = RADAR.BLOCCHI[blockIndex];
    const fonti = leggiFontiBlocco_(ss, blocco);

    if (sourceIndex >= fonti.length) {
      passaAlBloccoSuccessivo_(blockIndex, config);
      return;
    }

    const stato = caricaStato_(ss);
    let attempted = caricaAttempted_();

    for (let i = sourceIndex; i < fonti.length; i++) {
      if (Date.now() > deadlineMs - 15000) {
        props.setProperty(RADAR.PROP_RUN_SOURCE_INDEX, String(i));
        programmaProssimoBlocco_(Number(config.PAUSA_TRA_BLOCCHI_SEC || 10));
        return;
      }

      const source = fonti[i];
      const attemptKey = shortHash_(source.url);

      if (attempted.has(attemptKey)) {
        props.setProperty(RADAR.PROP_RUN_SOURCE_INDEX, String(i + 1));
        continue;
      }

      // Segna la fonte come tentata PRIMA del fetch: nessun retry nello stesso giorno.
      attempted.add(attemptKey);
      salvaAttempted_(attempted);

      const result = processaFonte_(ss, source, stato, config, deadlineMs);

      if (!result.ok) {
        incrementaErroriRun_(result.kind || 'SYSTEM');
      }

      props.setProperty(RADAR.PROP_RUN_SOURCE_INDEX, String(i + 1));

      if (Date.now() > deadlineMs - 15000 && i + 1 < fonti.length) {
        programmaProssimoBlocco_(Number(config.PAUSA_TRA_BLOCCHI_SEC || 10));
        return;
      }
    }

    passaAlBloccoSuccessivo_(blockIndex, config);
  } catch (e) {
    const msg = erroreTesto_(e);
    scriviLog_('', 'RADAR', 'ERRORE', 'Errore non gestito nel blocco: ' + msg);
    incrementaErroriRun_('SYSTEM');

    // Tenta di proseguire dal cursore già salvato senza perdere l'intera giornata.
    const ss = getSpreadsheet_();
    const config = leggiConfig_(ss);
    programmaProssimoBlocco_(Number(config.PAUSA_TRA_BLOCCHI_SEC || 10));
  } finally {
    lock.releaseLock();
  }
}


function processaFonte_(ss, source, stato, config, deadlineMs) {
  const started = Date.now();
  const fetchResult = fetchUrl_(source.url);

  if (!fetchResult.ok) {
    scriviLog_(source.blocco, source.fonte, 'ERRORE', fetchResult.detail + ' (' + (Date.now() - started) + ' ms)');
    return { ok: false, novita: 0, kind: 'FETCH' };
  }

  if (/application\/pdf/i.test(fetchResult.contentType || '')) {
    return processaFontePdfDiretta_(ss, source, stato, fetchResult, started);
  }

  const extraction = estraiElementiFonte_(source, fetchResult.body);

  if (source.parser === 'LISTA' && extraction.linkCount === 0) {
    scriviLog_(source.blocco, source.fonte, 'SOSPETTA', 'Parser LISTA ma nessun link HTML utile rilevato. (' + (Date.now() - started) + ' ms)');
    return { ok: false, novita: 0, kind: 'SOSPETTA' };
  }

  if (source.parser === 'TABELLA' && extraction.tableRows === 0) {
    scriviLog_(source.blocco, source.fonte, 'SOSPETTA', 'Parser TABELLA ma nessuna riga <tr> rilevata. (' + (Date.now() - started) + ' ms)');
    return { ok: false, novita: 0, kind: 'SOSPETTA' };
  }

  if (extraction.items.length === 0) {
    scriviLog_(source.blocco, source.fonte, 'SOSPETTA', 'Fonte raggiungibile ma nessun elemento utilizzabile estratto. (' + (Date.now() - started) + ' ms)');
    return { ok: false, novita: 0, kind: 'SOSPETTA' };
  }

  const sourceKey = canonicalizzaUrl_(source.url);
  const baselineStateKey = chiaveStato_(sourceKey, RADAR.BASELINE_KEY);
  const isBaseline = !stato.has(baselineStateKey);
  const stateRows = [];
  const opportunita = [];
  let dettagliUsati = 0;

  for (const item of extraction.items) {
    const itemKey = canonicalizzaUrl_(item.url || source.url);
    if (!itemKey) continue;

    const stateKey = chiaveStato_(sourceKey, itemKey);
    const oldHash = stato.get(stateKey) || '';
    const newHash = item.hash;
    const isNew = !oldHash;
    const isHashMigration = eMigrazioneHash_(oldHash, newHash);
    const isChanged = !!oldHash && oldHash !== newHash && !isHashMigration;

    if (titoloChiaramenteNonOpportunita_(item.title, item.url) || elementoScolasticoDaEscludere_(source, item.title, item.context)) {
      if (isNew || isChanged || isHashMigration) {
        stateRows.push([new Date(), sourceKey, itemKey, newHash, item.title]);
        stato.set(stateKey, newHash);
      }
      continue;
    }

    if (isBaseline) {
      if (isNew || isChanged) {
        stateRows.push([new Date(), sourceKey, itemKey, newHash, item.title]);
        stato.set(stateKey, newHash);
      }

      const indexText = item.title + ' ' + item.context;
      let detailText = '';
      let detailFetched = false;

      if (puoAprireDettaglio_(item.url) && dettagliUsati < Number(config.MAX_DETTAGLI_PER_FONTE || 8) && Date.now() < deadlineMs - 45000 && potenzialmenteRilevante_(source, indexText)) {
        dettagliUsati++;
        const detail = fetchUrl_(item.url);
        if (detail.ok && !/application\/pdf/i.test(detail.contentType || '')) {
          detailText = testoSignificativoDaHtml_(rimuoviChromePagina_(detail.body));
          detailFetched = true;
        }
      }

      const combinedText = [indexText, detailText].join(' ');
      const scadenza = estraiScadenza_(combinedText);
      if (scadenza && scadenzaFutura_(scadenza) && valutaRilevanza_(source, indexText, detailText, detailFetched)) {
        const baseTitle = pulisciTitolo_(item.title || source.fonte || source.ente);
        opportunita.push([
          new Date(), source.area,
          classificaTipo_(baseTitle, indexText, detailText),
          classificaCategoria_(source, baseTitle, combinedText),
          source.fonte, baseTitle, scadenza, item.url || source.url
        ]);
      }
      continue;
    }

    if (isHashMigration) {
      stateRows.push([new Date(), sourceKey, itemKey, newHash, item.title]);
      stato.set(stateKey, newHash);
      continue;
    }

    if (!isNew && !isChanged) continue;

    let detailText = '';
    let detailFetched = false;
    const indexText = item.title + ' ' + item.context;

    if (puoAprireDettaglio_(item.url) && dettagliUsati < Number(config.MAX_DETTAGLI_PER_FONTE || 8) && Date.now() < deadlineMs - 45000 && potenzialmenteRilevante_(source, indexText)) {
      dettagliUsati++;
      const detail = fetchUrl_(item.url);
      if (detail.ok && !/application\/pdf/i.test(detail.contentType || '')) {
        detailText = testoSignificativoDaHtml_(rimuoviChromePagina_(detail.body));
        detailFetched = true;
      }
    }

    const combinedText = [indexText, detailText].join(' ');
    const relevant = valutaRilevanza_(source, indexText, detailText, detailFetched);

    if (relevant) {
      const baseTitle = pulisciTitolo_(item.title || source.fonte || source.ente);
      const title = isChanged ? 'Aggiornamento: ' + baseTitle : baseTitle;
      opportunita.push([
        new Date(), source.area,
        classificaTipo_(baseTitle, indexText, detailText),
        classificaCategoria_(source, baseTitle, combinedText),
        source.fonte, title, estraiScadenza_(combinedText), item.url || source.url
      ]);
    }

    stateRows.push([new Date(), sourceKey, itemKey, newHash, item.title]);
    stato.set(stateKey, newHash);
  }

  if (isBaseline) {
    stateRows.push([new Date(), sourceKey, RADAR.BASELINE_KEY, '1', 'BASELINE']);
    stato.set(baselineStateKey, '1');
  }

  const inserted = appendOpportunita_(ss, opportunita);
  appendStato_(ss, stateRows);

  const detail = isBaseline
    ? 'Baseline acquisita: ' + extraction.items.length + ' elementi; ' + inserted + ' opportunità ancora aperte recuperate.'
    : 'Controllati ' + extraction.items.length + ' elementi; ' + inserted + ' novità/aggiornamenti.';

  scriviLog_(source.blocco, source.fonte, 'OK', detail + ' (' + (Date.now() - started) + ' ms)');
  return { ok: true, novita: inserted, kind: '' };
}

function processaFontePdfDiretta_(ss, source, stato, fetchResult, started) {
  const sourceKey = canonicalizzaUrl_(source.url);
  const baselineStateKey = chiaveStato_(sourceKey, RADAR.BASELINE_KEY);
  const isBaseline = !stato.has(baselineStateKey);
  const itemKey = sourceKey;
  const hash = hashSignificativo_(source.fonte + '|' + source.url);
  const stateKey = chiaveStato_(sourceKey, itemKey);
  const oldHash = stato.get(stateKey) || '';
  const rows = [];
  let inserted = 0;
  const isHashMigration = eMigrazioneHash_(oldHash, hash);

  if (!oldHash || oldHash !== hash) {
    if (!isBaseline && !isHashMigration) {
      inserted = appendOpportunita_(ss, [[
        new Date(), source.area,
        classificaTipo_(source.fonte, source.fonte, ''),
        classificaCategoria_(source, source.fonte, source.fonte),
        source.fonte, oldHash ? 'Aggiornamento: ' + source.fonte : source.fonte, '', source.url
      ]]);
    }
    rows.push([new Date(), sourceKey, itemKey, hash, source.fonte]);
    stato.set(stateKey, hash);
  }

  if (isBaseline) {
    rows.push([new Date(), sourceKey, RADAR.BASELINE_KEY, '1', 'BASELINE']);
    stato.set(baselineStateKey, '1');
  }

  appendStato_(ss, rows);
  scriviLog_(source.blocco, source.fonte, 'OK', (isBaseline ? 'Baseline PDF diretta acquisita.' : inserted + ' novità/aggiornamenti.') + ' (' + (Date.now() - started) + ' ms)');
  return { ok: true, novita: inserted, kind: '' };
}

function estraiElementiFonte_(source, html) {
  const parser = String(source.parser || '').toUpperCase();

  if (parser === 'TABELLA') {
    return estraiDaTabella_(source, html);
  }

  if (parser === 'PAGINA') {
    return estraiDaPagina_(source, html);
  }

  if (parser === 'SPECIALE_BURC') {
    return estraiBurc_(source, html);
  }

  return estraiDaLista_(source, html);
}


function estraiDaLista_(source, html) {
  const contentHtml = rimuoviChromePagina_(html);
  const anchors = estraiAnchors_(source.url, contentHtml);
  const items = deduplicaElementi_(anchors.filter(function(a) {
    return accettaLinkStrutturale_(a) && linkCompatibileConFonte_(source, a) &&
      canonicalizzaUrl_(a.url) !== canonicalizzaUrl_(source.url);
  }));

  return {
    items: items,
    linkCount: anchors.length,
    tableRows: contaMatch_(contentHtml, /<tr\b[^>]*>/gi)
  };
}


function estraiDaTabella_(source, html) {
  html = rimuoviChromePagina_(html);
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  let tableRows = 0;

  while ((m = rowRegex.exec(html)) !== null) {
    tableRows++;
    const rowHtml = m[1] || '';
    const rowText = pulisciTestoHtml_(rowHtml);
    const anchors = estraiAnchors_(source.url, rowHtml);

    for (const a of anchors) {
      if (!accettaLinkStrutturale_(a) || !linkCompatibileConFonte_(source, a)) continue;
      rows.push({
        url: a.url,
        title: a.title || tronca_(rowText, 240),
        context: tronca_(rowText, 900),
        hash: hashElementoLista_(a.title || '', rowText)
      });
    }
  }

  // Se la tabella esiste ma il markup è anomalo, conserva comunque eventuali link utili della pagina.
  if (rows.length === 0) {
    const anchors = estraiAnchors_(source.url, html).filter(function(a) {
      return accettaLinkStrutturale_(a) && linkCompatibileConFonte_(source, a);
    });
    rows.push.apply(rows, anchors);
  }

  return {
    items: deduplicaElementi_(rows),
    linkCount: rows.length,
    tableRows: tableRows
  };
}


function estraiDaPagina_(source, html) {
  const title = estraiTitoloPagina_(html) || source.fonte;
  const contentHtml = rimuoviChromePagina_(html);
  const pageText = testoSignificativoDaHtml_(contentHtml);
  const items = [{
    url: source.url,
    title: title,
    context: pageText,
    hash: hashSignificativo_(title + '|' + pageText)
  }];

  const anchors = estraiAnchors_(source.url, contentHtml);
  for (const a of anchors) {
    if (!accettaLinkStrutturale_(a) || !linkCompatibileConFonte_(source, a)) continue;
    const t = (a.title + ' ' + a.context).toLowerCase();
    if (eDocumento_(a.url) || contieneSegnaleOpportunita_(t) || contieneCoreFormazione_(t)) {
      items.push(a);
    }
  }

  return {
    items: deduplicaElementi_(items),
    linkCount: anchors.length,
    tableRows: contaMatch_(html, /<tr\b[^>]*>/gi)
  };
}


function estraiBurc_(source, html) {
  html = rimuoviChromePagina_(html);
  const anchors = estraiAnchors_(source.url, html);
  const selected = [];

  for (const a of anchors) {
    if (!accettaLinkStrutturale_(a)) continue;
    const t = (a.title + ' ' + a.context + ' ' + a.url).toLowerCase();
    if (/burc|bollettin|pdf|visualizza|download/.test(t)) {
      selected.push(a);
    }
  }

  return {
    items: deduplicaElementi_(selected),
    linkCount: anchors.length,
    tableRows: contaMatch_(html, /<tr\b[^>]*>/gi)
  };
}


function estraiAnchors_(baseUrl, html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html)) !== null) {
    const href = m[1] || m[2] || m[3] || '';
    const url = risolviUrl_(baseUrl, href);
    if (!url) continue;

    const rawTitle = pulisciTestoHtml_(m[4] || '');
    const title = rawTitle ? pulisciTitolo_(rawTitle) : titoloDaUrl_(url);
    const context = tronca_(contestoAnchor_(html, m.index, re.lastIndex), 1000);

    out.push({
      url: url,
      title: title,
      context: context,
      hash: hashElementoLista_(title, context)
    });
  }

  return out;
}


function contestoAnchor_(html, startIndex, endIndex) {
  const s = String(html || '');
  const containers = [
    ['<tr', '</tr>'],
    ['<li', '</li>'],
    ['<article', '</article>']
  ];

  for (const pair of containers) {
    const open = s.toLowerCase().lastIndexOf(pair[0], startIndex);
    const close = s.toLowerCase().indexOf(pair[1], endIndex);
    if (open >= 0 && close >= endIndex && close - open <= 5000) {
      return pulisciTestoHtml_(s.slice(open, close + pair[1].length));
    }
  }

  const start = Math.max(0, startIndex - 180);
  const end = Math.min(s.length, endIndex + 180);
  return pulisciTestoHtml_(s.slice(start, end));
}


function rimuoviChromePagina_(html) {
  let s = String(html || '');
  s = s.replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, ' ');
  s = s.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return s;
}


function hostDaUrl_(url) {
  const m = String(url || '').match(/^https?:\/\/([^\/:?#]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}


function linkCompatibileConFonte_(source, item) {
  const sourceHost = hostDaUrl_(source.url);
  const itemHost = hostDaUrl_(item.url);
  if (!itemHost || itemHost === sourceHost) return true;
  if (eDocumento_(item.url)) return true;

  const t = normalizzaTesto_((item.title || '') + ' ' + (item.context || ''));
  return contieneSegnaleOpportunita_(t) || contieneCoreFormazione_(t);
}


function titoloChiaramenteNonOpportunita_(title, url) {
  const t = normalizzaTesto_(title);
  const u = String(url || '').toLowerCase();
  if (!t || t === 'senza titolo' || t === 'elemento') return /^https?:\/\/[^\/]+\/?(?:[?#].*)?$/i.test(String(url || ''));
  if (/^(?:url|link|pagina|programma|home|leggi tutto|scopri|approfondisci|continua|read more|clicca qui|vai)$/.test(t)) return true;
  if (/^(?:webinar|convegni?|seminari?|video pillole(?: informative)?|area trasparenza|disposizioni sui fondi|normativa(?: sui fondi)?|ventennale\b|premio\b|concorso fotografico\b)/i.test(t)) return true;
  if (/\/privacy|\/cookie|\/trasparenza\/?$|\/normativa\/?$/.test(u)) return true;
  return false;
}

function hashElementoLista_(title, context) {
  const cleanTitle = normalizzaTesto_(title);
  const c = pulisciTestoHtml_(String(context || ''));
  const signals = [];
  const seen = new Set();

  const patterns = [
    /(?:scadenza|termine|entro|prorog\w*|rettific\w*|riapert\w*)[^.;|]{0,180}/gi,
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g,
    /\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+\d{4}\b/gi,
    /(?:€|euro)\s*[\d.,]+/gi,
    /(?:pubblicat\w*|approvat\w*|apert\w*|chius\w*|finanziat\w*)[^.;|]{0,120}/gi
  ];

  for (const re of patterns) {
    const matches = c.match(re) || [];
    for (const raw of matches) {
      const v = normalizzaTesto_(raw);
      if (!v || seen.has(v)) continue;
      seen.add(v);
      signals.push(v);
      if (signals.length >= 12) break;
    }
    if (signals.length >= 12) break;
  }

  // Se non ci sono segnali stabili, il titolo è intenzionalmente sufficiente:
  // evita falsi "aggiornamenti" causati da menu, banner e testo circostante variabile.
  return hashSignificativo_(cleanTitle + '|' + signals.join('|'));
}


function accettaLinkStrutturale_(item) {
  const url = String(item.url || '').trim();
  const title = String(item.title || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;

  const lowUrl = url.toLowerCase();
  const lowTitle = title.toLowerCase();

  if (/\.(?:jpg|jpeg|png|gif|svg|webp|ico|css|js|woff2?|ttf)(?:\?|$)/i.test(lowUrl)) return false;
  if (/facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|telegram\.me|t\.me|wa\.me|api\.whatsapp\.com|pinterest\./i.test(lowUrl)) return false;
  if (/(?:\/share\/|\/share\?|\/sharer|share=|addtoany|addthis)/i.test(lowUrl)) return false;

  if (/^(?:home|chi siamo|contatti|faq|statuto|organigramma|mappa del sito|area riservata|accedi|login|registrati|url|link|pagina|programma|leggi tutto|scopri|approfondisci|continua|read more|clicca qui|vai)$/i.test(title)) return false;
  if (/privacy|cookie|accessibil|sitemap|login|accedi|registrati|newsletter|feed|rss|amministrazione trasparente/.test(lowTitle)) return false;
  if (/\/privacy|\/cookie|\/accessibil|\/login|\/search|\/cerca(?:\/|\?|$)/.test(lowUrl)) return false;
  if (title.length < 3 && !eDocumento_(url)) return false;

  return true;
}

function deduplicaElementi_(items) {
  const map = new Map();

  for (const item of items) {
    const key = canonicalizzaUrl_(item.url);
    if (!key) continue;

    const existing = map.get(key);
    if (!existing || String(item.context || '').length > String(existing.context || '').length) {
      map.set(key, {
        url: key,
        title: pulisciTitolo_(item.title || titoloDaUrl_(key)),
        context: tronca_(item.context || '', 1200),
        hash: item.hash || hashSignificativo_((item.title || '') + '|' + (item.context || ''))
      });
    }
  }

  return Array.from(map.values());
}


function potenzialmenteRilevante_(source, text) {
  const t = normalizzaTesto_(text);
  if (fonteScolasticaGenerica_(source) && contieneEsclusioneScuola_(t)) return false;
  if (fonteSempreRilevante_(source)) return true;
  if (fonteGeneralista_(source)) return contieneSegnaleOpportunita_(t) && (contieneCoreFormazione_(t) || contieneSegnaleSupporto_(t));
  return contieneCoreFormazione_(t) || contieneSegnaleOpportunita_(t);
}

function valutaRilevanza_(source, indexText, detailText, detailFetched) {
  const index = normalizzaTesto_(indexText);
  const detail = normalizzaTesto_(detailText);

  if (fonteScolasticaGenerica_(source) && contieneEsclusioneScuola_(index)) return false;
  if (fonteSempreRilevante_(source)) return true;

  const indexCore = contieneCoreFormazione_(index);
  const indexOpportunity = contieneSegnaleOpportunita_(index);
  const indexSupporting = contieneSegnaleSupporto_(index);

  if (fonteGeneralista_(source)) {
    if (indexOpportunity && (indexCore || indexSupporting)) return true;
    if (detailFetched) {
      const detailCore = contieneCoreFormazione_(detail);
      const detailOpportunity = contieneSegnaleOpportunita_(detail);
      const detailSupporting = contieneSegnaleSupporto_(detail);
      return detailOpportunity && (detailCore || detailSupporting);
    }
    return false;
  }

  if (indexCore || (indexOpportunity && indexSupporting)) return true;
  if (detailFetched) {
    const detailCore = contieneCoreFormazione_(detail);
    const detailOpportunity = contieneSegnaleOpportunita_(detail);
    const detailSupporting = contieneSegnaleSupporto_(detail);
    if (detailCore || (detailOpportunity && detailSupporting)) return true;
  }
  if (!detailFetched && indexOpportunity && /servizi|progetto|intervento|percorso|attivit[aà]|fornitura/i.test(index)) return true;
  return false;
}

function contieneSegnaleSupporto_(text) {
  return /\b(?:digitale|intelligenza artificiale|\bia\b|ict|cyber|stem|orientament|inclusion|disabilit|pari opportunit|sicurezza sul lavoro|sanit|salute|green|transizion|management|pubblica amministrazione|capacity building|accompagnament|assistenza tecnica|servizi professionali|servizi specialistici|occupabilit|politiche attive)\b/i.test(text);
}


function fonteSempreRilevante_(source) {
  if (/^B1[234]_/.test(source.blocco)) return true;
  if (source.blocco === 'B01_SCUOLA') return true;
  if (source.blocco === 'B04_LAVORO') return true;
  if (source.blocco === 'B07_PA') return true;

  const f = normalizzaTesto_(source.fonte + ' ' + source.ente + ' ' + source.area);
  if (/pr campania fse\+|avvisi e bandi lavoro istruzione formazione/.test(f)) return true;
  if (/sviluppo competenze/.test(f)) return true;
  if (/fondo per la repubblica digitale/.test(f)) return true;
  if (/fami - avvisi pubblici|fami - calendario programmatico/.test(f)) return true;
  if (/per chi crea/.test(f)) return true;
  return false;
}

function fonteScolasticaGenerica_(source) {
  const f = normalizzaTesto_(source.fonte + ' ' + source.ente);
  return /usr campania|mim - normativa/.test(f);
}


function fonteGeneralista_(source) {
  const f = normalizzaTesto_(source.fonte + ' ' + source.ente + ' ' + source.area);
  if (/per chi crea|fondo per la repubblica digitale|sviluppo competenze/.test(f)) return false;
  if (/pr campania fse\+/.test(f)) return false;
  if (/avvisi e bandi lavoro istruzione formazione/.test(f)) return false;
  if (/lavoro e formazione professionale/.test(f)) return true;
  return ['B05_IMPRESE', 'B09_DIFESA', 'B10_SETTORI', 'B11_SPORT'].includes(source.blocco);
}


function elementoScolasticoDaEscludere_(source, title, context) {
  if (!fonteScolasticaGenerica_(source)) return false;
  const t = normalizzaTesto_(title);
  if (contieneEsclusioneScuola_(t)) return true;
  const c = normalizzaTesto_(tronca_(context || '', 500));
  return contieneEsclusioneScuola_(c) && !/(formazione|corso|percors\w* formativ|aggiornamento professional|competenze)/.test(t);
}

function contieneEsclusioneScuola_(text) {
  const t = normalizzaTesto_(text);
  return /concorso\w*(?: ordinario| straordinario)?(?:[^.]{0,80})?(?:docent|personale|scuola)|classe di concorso|classi di concorso|accertamento titoli|decreto idonei|idonei concorso|esecuzione sentenza|reclutamento (?:del )?personale|personale docente|personale ata|graduatori\w* (?:docent|ata|personale)|gps\b|immission\w* in ruolo|supplenz\w*|mobilit[aà]|pension\w*|sindac\w*|libri? di testo|esam\w* di stato/.test(t);
}

function contieneCoreFormazione_(text) {
  return /formaz|formativ|competenz|upskill|reskill|riqualific|qualificaz|certificaz\w* competenz|orientament|didattic|docent|student|scuol|istruzion|apprendist|tirocin|academy|percors\w* professional|politiche attive|occupabilit|alfabetizz|digital skills|capacity building|aggiornamento professional|sicurezza sul lavoro/.test(text);
}


function contieneSegnaleOpportunita_(text) {
  return /\b(?:avviso|bando|gara|affidament|appalto|manifestazione di interesse|finanziament|contribut|voucher|graduatori|ammess|finanziat|prorog|rettific|decreto|determina|delibera|programma(?:zione)?|stanziament|dotazione|call|procedura)\b/.test(text);
}


function classificaTipo_(title, indexText, detailText) {
  const titleType = classificaTipoForte_(normalizzaTesto_(title));
  if (titleType) return titleType;
  const indexType = classificaTipoPerPosizione_(normalizzaTesto_(indexText));
  if (indexType) return indexType;

  const detailType = classificaTipoPerPosizione_(normalizzaTesto_(detailText));
  return detailType || 'ALTRO';
}


function classificaTipoPerPosizione_(text) {
  const t = normalizzaTesto_(text);
  if (!t) return '';

  const candidates = [
    ['PROROGA/RETTIFICA', /prorog|rettific|errata corrige|riapertura dei termini/],
    ['AVVISO/BANDO', /\bbando\b|\bavviso\b|\bcall\b|voucher|manifestazione di interesse/],
    ['GARA/AFFIDAMENTO', /gara|affidament|appalto|procedura negoziata|\brdo\b/],
    ['STANZIAMENTO', /stanziament|dotazione finanziaria|risorse stanziate|rifinanziament/],
    ['DECRETO', /\bdecreto\b|\bdetermina\b|\bdelibera\b/],
    ['PROGRAMMAZIONE', /programmazione|calendario programmatico|programma (?:annuale|pluriennale|nazionale|regionale)/],
    ['NOTIZIA PRELIMINARE', /prossim\w* pubblicazione|di prossima uscita|in arrivo|preavviso|anticipazione/],
    ['GRADUATORIA/FINANZIATI', /graduatori|ammess|finanziat|beneficiar|esiti? (?:final|dell|del)|elenco (?:dei )?progetti/]
  ];

  let bestType = '';
  let bestPos = Number.MAX_SAFE_INTEGER;
  for (const pair of candidates) {
    const m = t.match(pair[1]);
    if (m && m.index < bestPos) {
      bestPos = m.index;
      bestType = pair[0];
    }
  }
  return bestType;
}


function classificaTipoForte_(text) {
  const t = normalizzaTesto_(text);
  if (!t) return '';
  if (/prorog|rettific|correzion|errata corrige|riapertura dei termini|modifica (?:dei|del|dell|alla|al) (?:termin|bando|avviso)/.test(t)) return 'PROROGA/RETTIFICA';
  if (/graduatori|ammess|finanziat|beneficiar|esiti? (?:final|dell|del)|elenco (?:dei )?progetti/.test(t)) return 'GRADUATORIA/FINANZIATI';
  if (/gara|affidament|appalto|procedura negoziata|me(?:pa|rcato elettronico)|\brdo\b/.test(t)) return 'GARA/AFFIDAMENTO';
  if (/\bbando\b|\bavviso\b|\bcall\b|voucher|manifestazione di interesse/.test(t)) return 'AVVISO/BANDO';
  if (/stanziament|dotazione finanziaria|risorse stanziate|rifinanziament/.test(t)) return 'STANZIAMENTO';
  if (/\bdecreto\b|\bdetermina\b|\bdelibera\b/.test(t)) return 'DECRETO';
  if (/programmazione|calendario programmatico|programma (?:annuale|pluriennale|nazionale|regionale)/.test(t)) return 'PROGRAMMAZIONE';
  if (/prossim\w* pubblicazione|di prossima uscita|in arrivo|preavviso|anticipazione/.test(t)) return 'NOTIZIA PRELIMINARE';
  return '';
}

function classificaCategoria_(source, title, text) {
  const primary = normalizzaTesto_(title + ' ' + source.area + ' ' + source.fonte + ' ' + source.ente);
  const full = normalizzaTesto_(primary + ' ' + text);

  if (/per chi crea/.test(primary)) {
    if (/\bstem\b/.test(primary)) return 'STEM';
    if (/digitale|multimedial|\bia\b/.test(primary)) return 'DIGITALE/IA';
    if (/inclusion|disabilit|svantagg/.test(primary)) return 'INCLUSIONE';
    return 'ALTRO';
  }

  const rules = [
    ['DIGITALE/IA', /intelligenza artificiale|\bia\b|artificial intelligence|digitale|digital|ict|cyber|cloud|data literacy/],
    ['STEM', /\bstem\b|scienze tecnologia ingegneria matematica/],
    ['ORIENTAMENTO', /orientament/],
    ['PARI OPPORTUNITA', /pari opportunit|parit[aà] di genere|gender|conciliazione vita lavoro/],
    ['INCLUSIONE', /inclusion|disabilit|fragilit|migrant|integrazione|fami|svantagg/],
    ['SICUREZZA', /sicurezza sul lavoro|salute e sicurezza|prevenzione rischi|d\.lgs\.? 81/],
    ['SANITA', /sanit|pnrr salute|medic|infermier|socio-sanitar/],
    ['GREEN', /green|transizione ecologica|sostenibil|ambiente|energia|economia circolare/],
    ['DOCENTI/PERSONALE SCOLASTICO', /docent|personale scolastico|insegnant/],
    ['MANAGEMENT/PA', /pubblica amministrazione|\bpa\b|management|managerial|dirigenza pubblica|dirigenti pubblici|valore pa/],
    ['COMPETENZE PROFESSIONALI', /formaz|competenz|upskill|reskill|riqualific|qualificaz|apprendist|tirocin|profession/]
  ];

  for (const pair of rules) if (pair[1].test(primary)) return pair[0];
  for (const pair of rules) if (pair[1].test(full)) return pair[0];
  return 'ALTRO';
}

function estraiScadenza_(text) {
  const clean = pulisciTestoHtml_(String(text || ''));
  if (!clean) return '';

  const monthNames = 'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';
  const dateRe = new RegExp('\\b(?:\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}|\\d{1,2}\\s+(?:' + monthNames + ')\\s+\\d{4})\\b', 'gi');
  const matches = [];
  let m;

  while ((m = dateRe.exec(clean)) !== null) {
    const raw = m[0];
    const start = Math.max(0, m.index - 180);
    const end = Math.min(clean.length, m.index + raw.length + 140);
    const context = normalizzaTesto_(clean.slice(start, end));
    let score = 0;

    if (/presentazione (?:delle )?candidatur|presentazione (?:delle )?domand|trasmissione (?:delle )?candidatur|invio (?:delle )?candidatur|invio (?:delle )?domand|termine (?:ultimo )?(?:per )?(?:la )?presentazione|domand\w*[^.]{0,70}(?:entro|termine|scadenza)|candidatur\w*[^.]{0,70}(?:entro|termine|scadenza)/.test(context)) score += 140;
    if (/scadenza|termine ultimo|entro e non oltre|entro le ore|entro il giorno|entro il|entro la/.test(context)) score += 55;
    if (/apertura (?:delle )?candidatur|apertura (?:delle )?domand/.test(context)) score += 20;
    if (/pubblicazione (?:delle |degli )?graduator|graduator\w*|pubblicazione (?:degli )?esiti|avvio (?:dei |delle )?progett|conclusione (?:dei |delle )?progett|rendicont|assistenza tecnica|richieste? di chiarimento|risposte? (?:alle )?richieste? di chiarimento/.test(context)) score -= 130;

    matches.push({ raw: raw, score: score, index: m.index });
  }

  if (matches.length === 0) return '';
  matches.sort(function(a, b) { if (b.score !== a.score) return b.score - a.score; return a.index - b.index; });
  if (matches[0].score <= 0) return '';
  return normalizzaFormatoScadenza_(matches[0].raw);
}


function normalizzaFormatoScadenza_(value) {
  const d = dataDaScadenza_(value);
  if (!d) return String(value || '').trim();
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

function scadenzaFutura_(value) {
  const d = dataDaScadenza_(value);
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() >= today.getTime();
}


function dataDaScadenza_(value) {
  const s = normalizzaTesto_(value);
  if (!s) return null;

  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
  }

  const months = {
    gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
    luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11
  };
  m = s.match(/^(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), months[m[2]], Number(m[1]), 23, 59, 59);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}


function fetchUrl_(url) {
  try {
    const response = UrlFetchApp.fetch(String(url).trim(), {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        'User-Agent': RADAR.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.7'
      }
    });

    const httpCode = response.getResponseCode();
    const headers = response.getHeaders();
    const contentType = headers['Content-Type'] || headers['content-type'] || '';
    const raw = response.getContent();
    const bytes = raw ? raw.length : 0;
    const body = /application\/pdf/i.test(contentType) ? '' : (response.getContentText() || '');
    const challenge = body ? rilevaPaginaBloccata_(body) : '';

    if (httpCode < 200 || httpCode >= 300) {
      return {
        ok: false,
        httpCode: httpCode,
        contentType: contentType,
        bytes: bytes,
        body: body,
        detail: 'HTTP ' + httpCode
      };
    }

    if (challenge) {
      return {
        ok: false,
        httpCode: httpCode,
        contentType: contentType,
        bytes: bytes,
        body: body,
        detail: 'Risposta anti-bot/accesso negato: ' + challenge
      };
    }

    if (!/application\/pdf/i.test(contentType) && bytes < 500) {
      return {
        ok: false,
        httpCode: httpCode,
        contentType: contentType,
        bytes: bytes,
        body: body,
        detail: 'Risposta HTTP valida ma troppo piccola (' + bytes + ' byte)'
      };
    }

    return {
      ok: true,
      httpCode: httpCode,
      contentType: contentType,
      bytes: bytes,
      body: body,
      detail: 'OK'
    };
  } catch (e) {
    return {
      ok: false,
      httpCode: '',
      contentType: '',
      bytes: 0,
      body: '',
      detail: erroreTesto_(e)
    };
  }
}


function rilevaPaginaBloccata_(html) {
  const t = String(html || '').toLowerCase();
  const patterns = [
    ['access denied', 'Access denied'],
    ['checking your browser', 'Browser challenge'],
    ['verify you are human', 'Verifica utente'],
    ['enable javascript and cookies to continue', 'Richiesta JavaScript/Cookie'],
    ['cf-chl-', 'Cloudflare challenge'],
    ['cf-browser-verification', 'Cloudflare browser verification'],
    ['attention required! | cloudflare', 'Cloudflare access block'],
    ['sorry, you have been blocked', 'Accesso bloccato']
  ];

  for (const pair of patterns) {
    if (t.includes(pair[0])) return pair[1];
  }

  return '';
}


function testoSignificativoDaHtml_(html) {
  let s = String(html || '');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = pulisciTestoHtml_(s);
  return testoSignificativo_(s);
}


function testoSignificativo_(text) {
  const s = pulisciTestoHtml_(String(text || ''));
  if (!s) return '';

  const needles = [
    'scadenza', 'candidatur', 'domand', 'presentazione', 'termine',
    'formaz', 'competenz', 'avviso', 'bando', 'gara', 'affidament', 'finanzi',
    'contribut', 'graduatori', 'prorog', 'rettific', 'decreto', 'programma',
    'stanzi', 'digitale', 'orientament', 'inclusion', 'stem', 'sicurezza',
    'sanit', 'green', 'management'
  ];

  const lower = s.toLowerCase();
  const windows = [];

  for (const needle of needles) {
    let pos = lower.indexOf(needle);
    if (pos < 0) continue;

    const start = Math.max(0, pos - 220);
    const end = Math.min(s.length, pos + 420);
    windows.push(s.slice(start, end));
    if (windows.length >= 8) break;
  }

  if (windows.length === 0) return tronca_(s, 1400);
  return tronca_(windows.join(' | '), 3200);
}


function estraiTitoloPagina_(html) {
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return pulisciTitolo_(pulisciTestoHtml_(h1[1]));

  const title = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? pulisciTitolo_(pulisciTestoHtml_(title[1])) : '';
}


function pulisciTestoHtml_(text) {
  return decodificaEntita_(String(text || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}


function decodificaEntita_(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, function(_, n) {
      return String.fromCharCode(Number(n));
    })
    .replace(/&#x([0-9a-f]+);/gi, function(_, n) {
      return String.fromCharCode(parseInt(n, 16));
    });
}


function normalizzaTesto_(text) {
  return pulisciTestoHtml_(String(text || ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


function pulisciTitolo_(text) {
  const t = pulisciTestoHtml_(text);
  return tronca_(t || 'Senza titolo', 300);
}


function titoloDaUrl_(url) {
  const clean = String(url || '').split('?')[0].replace(/\/$/, '');
  const last = clean.substring(clean.lastIndexOf('/') + 1);
  if (!last) return 'Elemento';
  return pulisciTitolo_(decodeURIComponentSafe_(last.replace(/[-_]+/g, ' ')));
}


function decodeURIComponentSafe_(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}


function risolviUrl_(baseUrl, href) {
  let h = decodificaEntita_(String(href || '').trim());
  if (!h || /^#/.test(h) || /^(?:javascript:|mailto:|tel:)/i.test(h)) return '';

  if (/^https?:\/\//i.test(h)) return canonicalizzaUrl_(h);

  const base = String(baseUrl || '').trim();
  const m = base.match(/^(https?):\/\/([^\/]+)(\/[^?#]*)?/i);
  if (!m) return '';

  const protocol = m[1];
  const host = m[2];
  const path = m[3] || '/';

  if (/^\/\//.test(h)) return canonicalizzaUrl_(protocol + ':' + h);
  if (/^\//.test(h)) return canonicalizzaUrl_(protocol + '://' + host + h);

  const dir = path.substring(0, path.lastIndexOf('/') + 1);
  let combined = dir + h;

  // Normalizzazione semplice di ./ e ../
  const parts = combined.split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }

  return canonicalizzaUrl_(protocol + '://' + host + '/' + normalized.join('/'));
}


function canonicalizzaUrl_(url) {
  let u = String(url || '').trim();
  if (!u) return '';

  u = u.replace(/&amp;/gi, '&');
  u = u.replace(/#.*$/, '');
  u = u.replace(/([?&])(?:utm_[^=&]+|fbclid|gclid|mc_cid|mc_eid)=[^&]*&?/gi, '$1');
  u = u.replace(/[?&]$/, '');
  u = u.replace(/\?&/, '?');

  return u;
}


function eDocumento_(url) {
  return /\.(?:pdf|docx?|xlsx?|pptx?|zip)(?:\?|$)/i.test(String(url || ''));
}


function puoAprireDettaglio_(url) {
  return /^https?:\/\//i.test(String(url || '')) && !eDocumento_(url);
}


function hashSignificativo_(text) {
  const normalized = pulisciTestoHtml_(String(text || '')).toLowerCase();
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    normalized,
    Utilities.Charset.UTF_8
  );

  const hex = digest.map(function(b) {
    const v = (b + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');

  return RADAR.HASH_VERSION + ':' + hex;
}


function eMigrazioneHash_(oldHash, newHash) {
  const oldV = String(oldHash || '');
  const newV = String(newHash || '');
  return !!oldV && !oldV.startsWith(RADAR.HASH_VERSION + ':') &&
    newV.startsWith(RADAR.HASH_VERSION + ':');
}


function shortHash_(text) {
  return hashSignificativo_(text).slice(-16);
}


function chiaveStato_(sourceKey, itemKey) {
  return sourceKey + '\n' + itemKey;
}


function caricaStato_(ss) {
  const sh = ss.getSheetByName(RADAR.FOGLIO_STATO);
  const map = new Map();
  if (!sh || sh.getLastRow() < 2) return map;

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, RADAR.HEADERS_STATO.length).getValues();
  for (const row of values) {
    const sourceKey = String(row[1] || '');
    const itemKey = String(row[2] || '');
    const hash = String(row[3] || '');
    if (!sourceKey || !itemKey) continue;
    map.set(chiaveStato_(sourceKey, itemKey), hash);
  }

  return map;
}


function appendStato_(ss, rows) {
  if (!rows || rows.length === 0) return;
  const sh = ss.getSheetByName(RADAR.FOGLIO_STATO);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, RADAR.HEADERS_STATO.length).setValues(rows);
}


function appendOpportunita_(ss, rows) {
  if (!rows || rows.length === 0) return 0;

  const sh = ss.getSheetByName(RADAR.FOGLIO_OPPORTUNITA);
  const props = PropertiesService.getScriptProperties();
  const startRow = Math.max(2, Number(props.getProperty(RADAR.PROP_RUN_START_ROW) || 2));
  const existing = new Set();
  const existingLinks = new Set();

  if (sh.getLastRow() >= startRow) {
    const vals = sh.getRange(startRow, 1, sh.getLastRow() - startRow + 1, RADAR.HEADERS_OPPORTUNITA.length).getValues();
    for (const r of vals) {
      existing.add(chiaveOpportunita_(r[4], r[5], r[7]));
      const link = canonicalizzaUrl_(r[7]);
      if (link) existingLinks.add(link);
    }
  }

  rows = riduciDoppioniStessaOpportunita_(rows);

  const filtered = [];
  for (const r of rows) {
    const key = chiaveOpportunita_(r[4], r[5], r[7]);
    const link = canonicalizzaUrl_(r[7]);
    if (existing.has(key)) continue;
    if (link && existingLinks.has(link)) continue;
    existing.add(key);
    if (link) existingLinks.add(link);
    filtered.push(r);
  }

  if (filtered.length > 0) sh.getRange(sh.getLastRow() + 1, 1, filtered.length, RADAR.HEADERS_OPPORTUNITA.length).setValues(filtered);
  return filtered.length;
}


function riduciDoppioniStessaOpportunita_(rows) {
  const keep = [];
  for (const row of rows) {
    const link = canonicalizzaUrl_(row[7]);
    if (!link) { keep.push(row); continue; }
    let replaced = false;
    let skip = false;

    for (let i = 0; i < keep.length; i++) {
      const other = keep[i];
      const otherLink = canonicalizzaUrl_(other[7]);
      if (!otherLink || hostDaUrl_(link) !== hostDaUrl_(otherLink)) continue;
      if (!urlPadreFiglio_(link, otherLink)) continue;
      if (!titoliCompatibiliStessaOpportunita_(row[5], other[5], link, otherLink)) continue;

      const scoreRow = specificitaUrl_(link) * 10 + String(row[5] || '').length;
      const scoreOther = specificitaUrl_(otherLink) * 10 + String(other[5] || '').length;
      if (scoreRow > scoreOther) { keep[i] = row; replaced = true; } else { skip = true; }
      break;
    }
    if (!replaced && !skip) keep.push(row);
  }
  return keep;
}


function urlPadreFiglio_(a, b) {
  const aa = String(a || '').split('?')[0].replace(/\/$/, '');
  const bb = String(b || '').split('?')[0].replace(/\/$/, '');
  if (!aa || !bb || aa === bb) return false;
  return aa.startsWith(bb + '/') || bb.startsWith(aa + '/');
}


function specificitaUrl_(url) {
  const m = String(url || '').match(/^https?:\/\/[^/]+(\/[^?#]*)?/i);
  const path = m && m[1] ? m[1] : '';
  return path.split('/').filter(Boolean).length;
}


function titoliCompatibiliStessaOpportunita_(a, b, urlA, urlB) {
  const ta = normalizzaTesto_(String(a || '').replace(/^aggiornamento:\s*/i, ''));
  const tb = normalizzaTesto_(String(b || '').replace(/^aggiornamento:\s*/i, ''));
  if (!ta || !tb) return false;
  if (ta.includes(tb) || tb.includes(ta)) return true;

  const stop = new Set(['avviso', 'pubblico', 'bando', 'per', 'gli', 'le', 'dei', 'delle', 'del', 'della', 'e', 'di', 'la', 'il', 'un', 'una', '2026', '2025']);
  const tokensA = ta.split(/\s+/).filter(function(x) { return x.length >= 3 && !stop.has(x); });
  const tokensB = tb.split(/\s+/).filter(function(x) { return x.length >= 3 && !stop.has(x); });
  const setB = new Set(tokensB);
  const common = tokensA.filter(function(x) { return setB.has(x); });
  if (common.length >= 2) return true;

  const parent = specificitaUrl_(urlA) < specificitaUrl_(urlB) ? urlA : urlB;
  const slugRaw = String(parent || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  const slug = normalizzaTesto_(slugRaw.replace(/-/g, ' '));
  return !!slug && slug.length >= 5 && (ta.includes(slug) || tb.includes(slug));
}

function chiaveOpportunita_(fonte, titolo, link) {
  return [String(fonte || ''), String(titolo || ''), canonicalizzaUrl_(link)].join('|');
}


function finalizzaRadar_() {
  const ss = getSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const config = leggiConfig_(ss);
  const errors = Number(props.getProperty(RADAR.PROP_RUN_ERRORS) || 0);
  const errorStats = {
    fetch: Number(props.getProperty(RADAR.PROP_RUN_FETCH_ERRORS) || 0),
    sospette: Number(props.getProperty(RADAR.PROP_RUN_SUSPECTS) || 0),
    sistema: Number(props.getProperty(RADAR.PROP_RUN_SYSTEM_ERRORS) || 0)
  };
  const startRow = Math.max(2, Number(props.getProperty(RADAR.PROP_RUN_START_ROW) || 2));
  const shOpp = ss.getSheetByName(RADAR.FOGLIO_OPPORTUNITA);

  let rows = [];
  if (shOpp.getLastRow() >= startRow) rows = shOpp.getRange(startRow, 1, shOpp.getLastRow() - startRow + 1, RADAR.HEADERS_OPPORTUNITA.length).getValues();

  if (rows.length > 0) {
    try {
      inviaEmailFinale_(ss, config, rows, errors, errorStats);
      scriviLog_('', 'RADAR', 'FINE', 'Sessione completata: ' + rows.length + ' novità/aggiornamenti; ' + descriviProblemiRun_(errorStats) + '.');
    } catch (e) {
      scriviLog_('', 'RADAR', 'ERRORE EMAIL', erroreTesto_(e));
    }
  } else {
    scriviLog_('', 'RADAR', 'FINE', 'Sessione completata: nessuna novità; ' + descriviProblemiRun_(errorStats) + '. Nessuna email inviata.');
  }

  potaLog_();
  pulisciRunProperties_();
  cancellaTriggerTemporanei_();
}

function inviaEmailFinale_(ss, config, rows, errors, errorStats) {
  const to = String(config.EMAIL_DESTINATARIO || '').trim();
  if (!to) throw new Error('CONFIG: EMAIL_DESTINATARIO è vuoto.');

  const tz = ss.getSpreadsheetTimeZone();
  const dateLabel = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy');
  const subject = 'Radar formazione - ' + rows.length + ' novità/aggiornamenti - ' + dateLabel;
  const plain = [];
  const html = [];

  plain.push('RADAR FORMAZIONE - ' + dateLabel, '');
  html.push('<p><strong>Radar formazione - ' + escapeHtml_(dateLabel) + '</strong></p>');
  html.push('<ol>');

  for (const r of rows) {
    const tipo = String(r[2] || '');
    const categoria = String(r[3] || '');
    const fonte = String(r[4] || '');
    const titolo = String(r[5] || '');
    let scadenza = r[6] || '';
    if (scadenza instanceof Date) scadenza = Utilities.formatDate(scadenza, tz, 'dd/MM/yyyy');
    else scadenza = String(scadenza || '');
    const link = String(r[7] || '');

    plain.push('- ' + titolo, '  ' + tipo + ' | ' + categoria + ' | ' + fonte + (scadenza ? ' | Scadenza: ' + scadenza : ''), '  ' + link, '');
    html.push('<li><strong>' + escapeHtml_(titolo) + '</strong><br>' + escapeHtml_(tipo) + ' | ' + escapeHtml_(categoria) + ' | ' + escapeHtml_(fonte) + (scadenza ? ' | Scadenza: ' + escapeHtml_(scadenza) : '') + '<br><a href="' + escapeHtmlAttr_(link) + '">Apri</a></li>');
  }

  html.push('</ol>');
  if (errors > 0) {
    const note = notaProblemiEmail_(errorStats || {});
    if (note) { plain.push(note); html.push('<p><small>' + escapeHtml_(note) + '</small></p>'); }
  }

  MailApp.sendEmail({ to: to, subject: subject, body: plain.join('\n'), htmlBody: html.join('\n'), name: 'Radar formazione' });
}

function passaAlBloccoSuccessivo_(blockIndex, config) {
  const props = PropertiesService.getScriptProperties();
  const next = blockIndex + 1;

  props.setProperty(RADAR.PROP_RUN_BLOCK_INDEX, String(next));
  props.setProperty(RADAR.PROP_RUN_SOURCE_INDEX, '0');

  if (next >= RADAR.BLOCCHI.length) {
    finalizzaRadar_();
    return;
  }

  programmaProssimoBlocco_(Number(config.PAUSA_TRA_BLOCCHI_SEC || 10));
}


function programmaProssimoBlocco_(seconds) {
  cancellaTriggerTemporanei_();
  const delayMs = Math.max(1, Number(seconds || 1)) * 1000;

  ScriptApp.newTrigger(RADAR.HANDLER_BLOCCO)
    .timeBased()
    .after(delayMs)
    .create();
}


function creaTriggerFeriali_() {
  const ss = getSpreadsheet_();
  const config = leggiConfig_(ss);
  const hour = Math.min(23, Math.max(0, Number(config.ORA_AVVIO || 8)));
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const days = [
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY
  ];

  for (const day of days) {
    ScriptApp.newTrigger(RADAR.HANDLER_GIORNALIERO)
      .timeBased()
      .onWeekDay(day)
      .atHour(hour)
      .inTimezone(tz)
      .create();
  }
}


function cancellaTriggerRadar_() {
  const handlers = new Set([RADAR.HANDLER_GIORNALIERO, RADAR.HANDLER_BLOCCO]);
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (handlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}


function cancellaTriggerTemporanei_() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === RADAR.HANDLER_BLOCCO) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}


function leggiFontiBlocco_(ss, blocco) {
  const sh = ss.getSheetByName(RADAR.FOGLIO_FONTI);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const values = sh.getRange(2, 1, lastRow - 1, RADAR.HEADERS_FONTI.length).getValues();
  const out = [];

  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (String(r[0] || '').trim() !== blocco) continue;
    if (!String(r[4] || '').trim()) continue;

    out.push({
      rowNumber: i + 2,
      blocco: String(r[0] || '').trim(),
      area: String(r[1] || '').trim(),
      ente: String(r[2] || '').trim(),
      fonte: String(r[3] || '').trim(),
      url: String(r[4] || '').trim(),
      parser: String(r[5] || '').trim().toUpperCase()
    });
  }

  return out;
}


function validaFonti_(ss) {
  const sh = ss.getSheetByName(RADAR.FOGLIO_FONTI);
  if (!sh) throw new Error('Manca il foglio "' + RADAR.FOGLIO_FONTI + '".');

  const headers = sh.getRange(1, 1, 1, RADAR.HEADERS_FONTI.length).getDisplayValues()[0];
  for (let i = 0; i < RADAR.HEADERS_FONTI.length; i++) {
    if (String(headers[i] || '').trim() !== RADAR.HEADERS_FONTI[i]) {
      throw new Error('FONTI_V1: intestazione non valida in colonna ' + (i + 1) + '. Attesa: ' + RADAR.HEADERS_FONTI[i]);
    }
  }

  if (sh.getLastRow() < 2) throw new Error('FONTI_V1 non contiene fonti.');

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, RADAR.HEADERS_FONTI.length).getValues();
  const urls = new Set();

  for (let i = 0; i < values.length; i++) {
    const rowNum = i + 2;
    const blocco = String(values[i][0] || '').trim();
    const url = String(values[i][4] || '').trim();
    const parser = String(values[i][5] || '').trim().toUpperCase();

    if (!blocco || !url || !parser) {
      throw new Error('FONTI_V1: riga ' + rowNum + ' incompleta.');
    }
    if (!RADAR.BLOCCHI.includes(blocco)) {
      throw new Error('FONTI_V1: blocco non riconosciuto alla riga ' + rowNum + ': ' + blocco);
    }
    if (!RADAR.PARSER_AMMESSI.includes(parser)) {
      throw new Error('FONTI_V1: parser non ammesso alla riga ' + rowNum + ': ' + parser);
    }

    const canonical = canonicalizzaUrl_(url);
    if (urls.has(canonical)) {
      throw new Error('FONTI_V1: URL duplicato alla riga ' + rowNum + ': ' + url);
    }
    urls.add(canonical);
  }
}


function preparaConfig_(ss) {
  let sh = ss.getSheetByName(RADAR.FOGLIO_CONFIG);
  if (!sh) sh = ss.insertSheet(RADAR.FOGLIO_CONFIG);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 2).setValues([['CHIAVE', 'VALORE']]);
  } else {
    const h = sh.getRange(1, 1, 1, 2).getDisplayValues()[0];
    if (String(h[0] || '').trim() !== 'CHIAVE' || String(h[1] || '').trim() !== 'VALORE') {
      throw new Error('CONFIG deve avere le colonne CHIAVE | VALORE.');
    }
  }

  const existing = new Map();
  if (sh.getLastRow() >= 2) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (const r of vals) {
      const key = String(r[0] || '').trim();
      if (key) existing.set(key, r[1]);
    }
  }

  const emailDefault = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || '';
  const toAppend = [];

  for (const pair of RADAR.DEFAULT_CONFIG) {
    const key = pair[0];
    let value = pair[1];
    if (key === 'EMAIL_DESTINATARIO' && !value) value = emailDefault;
    if (!existing.has(key)) toAppend.push([key, value]);
  }

  if (toAppend.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, 2).setValues(toAppend);
  }

  sh.setFrozenRows(1);
  sh.getRange('A1:B1').setFontWeight('bold');
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 320);
}


function leggiConfig_(ss) {
  const sh = ss.getSheetByName(RADAR.FOGLIO_CONFIG);
  if (!sh) throw new Error('Manca il foglio CONFIG. Eseguire setupRadar().');

  const out = {};
  if (sh.getLastRow() >= 2) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (const r of vals) {
      const key = String(r[0] || '').trim();
      if (key) out[key] = r[1];
    }
  }

  return out;
}


function preparaFoglioConHeaders_(ss, name, headers, hide) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const current = sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    for (let i = 0; i < headers.length; i++) {
      if (String(current[i] || '').trim() !== headers[i]) {
        throw new Error(name + ': intestazioni non coerenti con il RADAR V1.');
      }
    }
  }

  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');

  if (name === RADAR.FOGLIO_OPPORTUNITA) {
    sh.setColumnWidth(1, 140);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 190);
    sh.setColumnWidth(4, 220);
    sh.setColumnWidth(5, 280);
    sh.setColumnWidth(6, 520);
    sh.setColumnWidth(7, 140);
    sh.setColumnWidth(8, 500);
  }

  if (name === RADAR.FOGLIO_LOG) {
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 150);
    sh.setColumnWidth(3, 300);
    sh.setColumnWidth(4, 140);
    sh.setColumnWidth(5, 520);
  }

  if (hide && !sh.isSheetHidden()) sh.hideSheet();
  return sh;
}


function scriviLog_(blocco, fonte, esito, dettaglio) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(RADAR.FOGLIO_LOG);
  if (!sh) sh = preparaFoglioConHeaders_(ss, RADAR.FOGLIO_LOG, RADAR.HEADERS_LOG, false);

  sh.appendRow([
    new Date(),
    String(blocco || ''),
    String(fonte || ''),
    String(esito || ''),
    tronca_(String(dettaglio || ''), 1000)
  ]);
}


function potaLog_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(RADAR.FOGLIO_LOG);
  if (!sh || sh.getLastRow() < 2) return;

  const config = leggiConfig_(ss);
  const days = Math.max(1, Number(config.GIORNI_LOG || 30));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  let deleteCount = 0;

  for (let i = 0; i < values.length; i++) {
    const d = values[i][0];
    if (d instanceof Date && d.getTime() < cutoff) {
      deleteCount++;
    } else {
      break;
    }
  }

  if (deleteCount > 0) sh.deleteRows(2, deleteCount);
}


function caricaAttempted_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RADAR.PROP_RUN_ATTEMPTED) || '[]';
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}


function salvaAttempted_(set) {
  PropertiesService.getScriptProperties()
    .setProperty(RADAR.PROP_RUN_ATTEMPTED, JSON.stringify(Array.from(set)));
}


function incrementaErroriRun_(kind) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(RADAR.PROP_RUN_ERRORS) || 0) + 1;
  props.setProperty(RADAR.PROP_RUN_ERRORS, String(n));

  const k = String(kind || 'SYSTEM').toUpperCase();
  let prop = RADAR.PROP_RUN_SYSTEM_ERRORS;
  if (k === 'FETCH') prop = RADAR.PROP_RUN_FETCH_ERRORS;
  if (k === 'SOSPETTA') prop = RADAR.PROP_RUN_SUSPECTS;
  const part = Number(props.getProperty(prop) || 0) + 1;
  props.setProperty(prop, String(part));
}


function descriviProblemiRun_(stats) {
  const fetch = Number(stats && stats.fetch || 0);
  const sospette = Number(stats && stats.sospette || 0);
  const sistema = Number(stats && stats.sistema || 0);
  const total = fetch + sospette + sistema;
  if (total === 0) return 'nessuna fonte problematica';

  const parts = [];
  if (fetch) parts.push(fetch + (fetch === 1 ? ' fonte non raggiungibile' : ' fonti non raggiungibili'));
  if (sospette) parts.push(sospette + (sospette === 1 ? ' fonte raggiungibile ma non leggibile dal parser' : ' fonti raggiungibili ma non leggibili dal parser'));
  if (sistema) parts.push(sistema + (sistema === 1 ? ' errore tecnico di sessione' : ' errori tecnici di sessione'));
  return parts.join('; ');
}


function notaProblemiEmail_(stats) {
  const desc = descriviProblemiRun_(stats);
  if (desc === 'nessuna fonte problematica') return '';
  return 'Controllo incompleto: ' + desc + '.';
}

function pulisciRunProperties_() {
  const props = PropertiesService.getScriptProperties();
  const keys = [
    RADAR.PROP_RUN_ACTIVE,
    RADAR.PROP_RUN_ID,
    RADAR.PROP_RUN_START_MS,
    RADAR.PROP_RUN_BLOCK_INDEX,
    RADAR.PROP_RUN_SOURCE_INDEX,
    RADAR.PROP_RUN_START_ROW,
    RADAR.PROP_RUN_ERRORS,
    RADAR.PROP_RUN_FETCH_ERRORS,
    RADAR.PROP_RUN_SUSPECTS,
    RADAR.PROP_RUN_SYSTEM_ERRORS,
    RADAR.PROP_RUN_ATTEMPTED
  ];

  for (const key of keys) props.deleteProperty(key);
}


function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(RADAR.PROP_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet non disponibile. Eseguire setupRadar() dal foglio corretto.');
  return ss;
}


function contaMatch_(text, regex) {
  const matches = String(text || '').match(regex);
  return matches ? matches.length : 0;
}


function tronca_(text, maxLen) {
  const s = String(text || '');
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}


function erroreTesto_(e) {
  return tronca_(String(e && e.message ? e.message : e), 700);
}


function escapeHtml_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function escapeHtmlAttr_(text) {
  return escapeHtml_(text).replace(/`/g, '&#96;');
}
