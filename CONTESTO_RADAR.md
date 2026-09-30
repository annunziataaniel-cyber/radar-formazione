# CONTESTO RADAR FORMAZIONE — stato di handoff a Codex

Data di handoff: 30/09/2026.

## 1. Obiettivo

Costruire e mantenere un RADAR V1 in Google Apps Script che controlli fonti istituzionali italiane e fondi interprofessionali per individuare opportunità rilevanti per:
- un formatore;
- enti di formazione con cui collabora/che assiste;
- opportunità da segnalare a clienti e partner.

Ambito: Italia nazionale + Regione Campania. Fondi UE solo se gestiti/pubblicati tramite amministrazioni italiane. Inclusi fondi interprofessionali, Forma.Temp, gare/affidamenti per servizi di formazione e misure in cui il beneficiario formale sia scuola/impresa/PA ma possano entrare formatori, enti, partner o fornitori esterni.

Principio di filtro: preferire qualche falso positivo a un falso negativo, ma senza trasformare la mail in rumore. Non limitarsi ai soli bandi aperti: intercettare programmazione, stanziamenti, decreti, avvisi/bandi, gare, proroghe/rettifiche, graduatorie/finanziati, notizie preliminari e aggiornamenti significativi.

## 2. Architettura vincolante

Google Apps Script su un Google Sheet già esistente. Fogli:
- `FONTI_V1`: BLOCCO | AREA | ENTE | FONTE | URL | PARSER
- `CONFIG`: impostazioni globali
- `OPPORTUNITA`: DATA | AREA | TIPO | CATEGORIA | FONTE | TITOLO | SCADENZA | LINK
- `LOG`: DATA/ORA | BLOCCO | FONTE | ESITO | DETTAGLIO
- `STATO`: tecnico, nascosto

Niente menu e niente pulsanti. Setup iniziale tramite `setupRadar()` una sola volta. Dopo setup l'utente non deve entrare normalmente nel codice.

Trigger: lun-ven circa ore 08:00. Apps Script ha mostrato timeout intorno ai 6 minuti, quindi il radar lavora per BLOCCO e concatena esecuzioni. Target prudenziale per blocco: ~4–4,5 minuti. Una sola email finale dopo tutti i blocchi. Se una fonte fallisce: LOG e avanti, niente retry nello stesso giorno.

## 3. Stato attuale

Versione codice corrente: **RADAR V1.2**, file `Codice.gs` in questa cartella.

`FONTI_V1.tsv` contiene lo stato corrente di **59 fonti operative**.

Il setup è già stato eseguito e i trigger feriali sono già presenti. **NON eseguire automaticamente `setupRadar()` durante modifiche o test**, salvo richiesta esplicita dell'utente.

Il prossimo normale ciclo deve partire automaticamente in un giorno feriale nella fascia delle 08:00. Non è necessario avviare manualmente nulla.

## 4. Baseline e stato

Ogni nuova fonte fa una baseline. Storicamente la prima esecuzione memorizzava tutto senza notificare. Dopo il caso Per Chi Crea, la V1.1/V1.2 è stata adattata: una nuova fonte può recuperare subito opportunità ancora aperte con scadenza futura, mentre lo storico viene messo a baseline.

Dalle esecuzioni successive:
- URL nuovo = candidato nuovo elemento;
- URL noto = confronto tramite hash significativo;
- l'hash non deve dipendere dall'intera pagina o da menu/template instabili;
- aggiornamenti reali devono essere registrati; cambi cosmetici non devono generare valanghe.

Non fare deduplicazione semantica generale tra fonti diverse: la stessa misura su MIM e USR può restare due righe. È però accettata una deduplica conservativa per stesso URL nella stessa giornata e per pagina-contenitore/sottopagina della stessa opportunità quando il legame è evidente.

## 5. Parser ammessi

Tipi nel foglio:
- LISTA
- TABELLA
- PAGINA
- SPECIALE_BURC

PDF non è un parser. Nella V1 niente OCR e niente parsing PDF sofisticato: conservare link e usare titolo/contesto HTML circostante.

## 6. TIPO e CATEGORIA

TIPO deve restare nella lista:
- PROGRAMMAZIONE
- STANZIAMENTO
- DECRETO
- AVVISO/BANDO
- GARA/AFFIDAMENTO
- PROROGA/RETTIFICA
- GRADUATORIA/FINANZIATI
- NOTIZIA PRELIMINARE
- ALTRO

CATEGORIA:
- DIGITALE/IA
- COMPETENZE PROFESSIONALI
- DOCENTI/PERSONALE SCOLASTICO
- STEM
- ORIENTAMENTO
- INCLUSIONE
- PARI OPPORTUNITA
- SICUREZZA
- SANITA
- GREEN
- MANAGEMENT/PA
- ALTRO

## 7. Esclusioni esplicite / rumore da bloccare

In particolare su fonti scolastiche escludere contenuti puramente amministrativi del personale senza legame con formazione finanziata:
- concorsi docenti e personale;
- mobilità;
- pensioni;
- sindacati;
- libri di testo;
- esami di Stato;
- supplenze;
- classi di concorso / accertamento titoli / idonei se riferiti a reclutamento.

V1.2 aggiunge filtri per link social/share (`telegram.me/share` ecc.), titoli generici (`url`, `programma`, `pagina`, `leggi tutto` ecc.) e rumore da menu/header/footer.

## 8. Fonti escluse per problemi tecnici accertati

Non reintrodurre automaticamente senza una nuova ragione tecnica verificata:
- Dipartimento Pari Opportunità, portale generale: Address unavailable;
- Presidenza del Consiglio / Trasparenza DPO: Address unavailable;
- certificazione.pariopportunita.gov.it/public/contributi: shell dinamica inutile a LISTA;
- Dipartimento Funzione Pubblica: Address unavailable;
- Ministero Salute portale generale: HTTP 403; sostituito da PNRR Salute;
- Ministero Turismo / Avvisi pubblici: pagina non utile a LISTA in Apps Script;
- Fondimpresa diretta: host/endpoints testati non affidabili (Address unavailable / HTTP 500), copertura indiretta;
- FondoFormazione: pagina-guscio, 0 link utili.

## 9. Caso Ministero della Cultura

`cultura.gov.it`, `www.cultura.gov.it` e `beniculturali.it` hanno mostrato `Address unavailable` da UrlFetchApp dopo ~50 s. Non è un errore del parser.

La fonte operativa è stata sostituita con:
- ENTE: Ministero della Cultura
- FONTE: `MiC Trasparenza - Avvisi e bandi`
- URL: `https://trasparenza.cultura.gov.it/pagina957_avvisi-e-bandi.html`
- PARSER: TABELLA

Test mirato riuscito con HTTP 200 e baseline acquisita (30 elementi). Non ripristinare il vecchio host senza nuovo test Apps Script.

## 10. Caso Fondoprofessioni / motivo V1.1

Una mail del 30/09/2026 ha prodotto 42 segnalazioni, ma solo 22 URL distinti: 20 doppioni esatti. Quasi tutto proveniva da due fonti Fondoprofessioni e includeva webinar, convegni, area trasparenza, normative e altre pagine non-opportunità.

Cause individuate:
- hash troppo sensibile al contesto HTML/template;
- fonti specialistiche trattate in modo troppo permissivo;
- stessa URL accettata due volte se proveniente da due righe-fonte diverse.

V1.1/V1.2 stabilizza hash e deduplica per URL nella giornata, elimina rumore strutturale e filtra titoli chiaramente non-opportunità.

## 11. Caso Per Chi Crea / SIAE

Il Bando 2 "Formazione e promozione culturale nelle scuole – Per Chi Crea 2026" non era stato trovato perché SIAE / Per Chi Crea non era inizialmente tra le fonti.

Sono state aggiunte tre fonti:
1. B01_SCUOLA — `Per Chi Crea - Formazione nelle scuole` — PAGINA
2. B10_SETTORI — `Per Chi Crea - Bandi` — LISTA
3. B10_SETTORI — `Per Chi Crea - News` — LISTA

Il bando è un esempio centrale del tipo di opportunità da intercettare: il beneficiario formale è una scuola, ma il progetto può coinvolgere organizzazioni pubbliche/private di settore come prestatrici di servizi remunerate.

Il Bando 2 2026 prevede almeno 60 ore di formazione e almeno 45 studenti; contributo massimo 25.000 euro per progetto; scadenza candidatura 29/10/2026 ore 14:00. Il 01/03/2027 è la data prevista per le graduatorie, NON la scadenza candidatura.

La V1.2 corregge proprio l'estrazione date per dare priorità a "presentazione candidatura/domanda" rispetto a graduatorie/avvio/rendicontazione.

## 12. Problemi corretti in V1.2

Dalla mail da 11 elementi del 30/09/2026 sono emersi e sono stati corretti:
- concorsi/reclutamento USR Campania segnalati impropriamente;
- link Telegram-share trattato come contenuto;
- titolo generico `programma`;
- Per Chi Crea classificato erroneamente come GRADUATORIA/FINANZIATI e MANAGEMENT/PA;
- scadenza Per Chi Crea letta come 01/03/2027 invece di 29/10/2026;
- `Bando Polaris 2` classificato DECRETO invece di AVVISO/BANDO;
- avvisi generalisti senza relazione concreta con formazione lasciati passare;
- due pagine EPS 2026 quasi duplicate;
- nota finale troppo generica su fonti problematiche.

## 13. Regole di lavoro per Codex

1. Leggere prima questo file e poi `Codice.gs` e `FONTI_V1.tsv`.
2. Prima di modificare, descrivere il problema reale e il cambiamento proposto.
3. Non aggiungere feature non necessarie alla V1.x.
4. Evitare refactoring estetici massivi che rendono difficile confrontare il codice.
5. Non cambiare schema dei fogli senza richiesta esplicita.
6. Non reintrodurre fonti escluse senza prova tecnica nuova.
7. Non fare test globali delle 59 fonti quando basta un test mirato.
8. Per modifiche sostanziali restituire un `Codice.gs` intero e coerente, non patch frammentarie.
9. Conservare la robustezza contro timeout, concatenazione dei blocchi, crash di singola fonte e invio di una sola email finale.
10. Se si modifica la logica di hash/baseline, evitare assolutamente di trasformare lo storico in una valanga di falsi aggiornamenti.

## 14. Primo compito consigliato in Codex

Non modificare nulla subito. Eseguire una review statica di `Codice.gs` rispetto a questo documento e produrre:
- eventuali bug reali;
- rischi di timeout o race condition;
- rischio di falsi positivi/falsi negativi;
- parti che potrebbero generare duplicati;
- test mirati utili.

Non proporre una riscrittura completa se non necessaria.
