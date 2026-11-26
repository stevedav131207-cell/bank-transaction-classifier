import { useEffect, useMemo, useState } from 'react'

const API = `${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api`
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0)
const percent = value => `${(Number(value || 0) * 100).toFixed(1)}%`

async function readApi(response) {
  const raw = await response.text()
  let data
  try { data = raw ? JSON.parse(raw) : {} } catch { data = { detail: raw || `HTTP ${response.status}` } }
  if (!response.ok) {
    const detail = data.detail
    const message = typeof detail === 'string' ? detail : detail?.errors?.join(' ') || JSON.stringify(detail || data)
    throw new Error(message || `Request failed (${response.status})`)
  }
  return data
}

function confidenceBand(value) {
  if (value > 0.8) return { label: 'High', className: 'high' }
  if (value >= 0.5) return { label: 'Medium', className: 'medium' }
  return { label: 'Low', className: 'low' }
}

function App() {
  const [file, setFile] = useState(null)
  const [rows, setRows] = useState([])
  const [counts, setCounts] = useState({})
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState({ type: '', message: '' })
  const [busy, setBusy] = useState(false)
  const [singleText, setSingleText] = useState('')
  const [singleResult, setSingleResult] = useState(null)
  const [filter, setFilter] = useState('All')
  const [activeView, setActiveView] = useState('overview')
  const [metrics, setMetrics] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [apiState, setApiState] = useState('checking')
  const [dragging, setDragging] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('ledgerlens-theme') || 'dark')

  useEffect(() => { localStorage.setItem('ledgerlens-theme', theme) }, [theme])

  useEffect(() => {
    let alive = true
    Promise.all([fetch(`${API}/health`).then(readApi), fetch(`${API}/metrics`).then(readApi), fetch(`${API}/analytics`).then(readApi)])
      .then(([health, modelMetrics, history]) => {
        if (!alive) return
        setApiState(health.status === 'ok' ? 'connected' : 'unknown')
        setMetrics(modelMetrics); setAnalytics(history)
      })
      .catch(() => { if (alive) setApiState('unavailable') })
    return () => { alive = false }
  }, [])

  const visibleRows = useMemo(() => rows.filter(row =>
    (filter === 'All' || row.predicted_category === filter) &&
    String(row.transaction_description || '').toLowerCase().includes(search.toLowerCase())
  ), [rows, filter, search])
  const total = rows.length
  const averageConfidence = total ? rows.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / total : 0
  const maxCount = Math.max(...Object.values(counts).map(Number), 1)
  const lowConfidenceCount = rows.filter(row => Number(row.confidence) < 0.5).length
  const financialSummary = useMemo(() => {
    const categories = new Map()
    let totalDebit = 0, totalCredit = 0, debitRows = 0, creditRows = 0, amountRows = 0
    for (const row of rows) {
      const amount = Number(row.amount)
      if (!Number.isFinite(amount)) continue
      amountRows++
      const value = Math.abs(amount)
      const type = String(row.transaction_type || '').trim().toLowerCase()
      const category = row.predicted_category || 'Uncategorized'
      if (!categories.has(category)) categories.set(category, { category, debit: 0, credit: 0, debitCount: 0, creditCount: 0 })
      const item = categories.get(category)
      if (type === 'debit' || type === 'withdrawal' || type === 'dr') {
        totalDebit += value; debitRows++; item.debit += value; item.debitCount++
      } else if (type === 'credit' || type === 'deposit' || type === 'cr') {
        totalCredit += value; creditRows++; item.credit += value; item.creditCount++
      }
    }
    return { categories: [...categories.values()].sort((a,b) => b.debit-a.debit), totalDebit, totalCredit, debitRows, creditRows, amountRows }
  }, [rows])
  const pieColors = ['#b8e66b','#70c7b4','#80aee8','#d6a1e8','#e7b76b','#e88989','#7dc9df','#b4c17b','#d28cba','#8c9be0','#c5a77d','#83b6a0']
  const pieGradient = useMemo(() => {
    const values = financialSummary.categories.filter(item => item.debit > 0)
    const sum = values.reduce((acc, item) => acc + item.debit, 0)
    if (!sum) return 'conic-gradient(#344454 0deg 360deg)'
    let cursor = 0
    return `conic-gradient(${values.map((item, index) => { const start = cursor; cursor += item.debit / sum * 360; return `${pieColors[index % pieColors.length]} ${start}deg ${cursor}deg` }).join(', ')})`
  }, [financialSummary, pieColors])

  function chooseFile(nextFile) {
    if (!nextFile) return
    if (!nextFile.name.toLowerCase().endsWith('.csv')) {
      setStatus({ type: 'error', message: 'Unsupported file. Please choose a CSV file.' }); return
    }
    if (nextFile.size > 25 * 1024 * 1024) {
      setStatus({ type: 'error', message: 'The CSV must be smaller than 25 MB.' }); return
    }
    setFile(nextFile); setStatus({ type: 'info', message: 'File selected. Validate the dataset before categorization.' })
  }

  async function uploadAndPredict() {
    if (!file) return setStatus({ type: 'error', message: 'Choose a CSV file first.' })
    setBusy(true); setStatus({ type: 'loading', message: 'Checking file structure and data quality…' })
    try {
      const validationBody = new FormData(); validationBody.append('file', file)
      const validation = await readApi(await fetch(`${API}/validate`, { method: 'POST', body: validationBody }))
      if (!validation.valid) throw new Error(validation.errors?.join(' ') || 'Dataset validation failed.')
      setStatus({ type: 'loading', message: `Validation passed · ${validation.row_count.toLocaleString()} rows inspected. Categorizing…` })
      const body = new FormData(); body.append('file', file)
      const data = await readApi(await fetch(`${API}/predict/batch`, { method: 'POST', body }))
      setRows(data.rows || []); setCounts(data.category_counts || {}); setFilter('All'); setSearch('')
      setStatus({ type: 'success', message: `Completed: ${data.total.toLocaleString()} transactions categorized; ${data.skipped} skipped.${[...(validation.warnings || []), ...(data.warnings || [])].length ? ` Warnings: ${[...(validation.warnings || []), ...(data.warnings || [])].join(' ')}` : ''}` })
      setActiveView('analysis')
      fetch(`${API}/analytics`).then(readApi).then(setAnalytics).catch(() => {})
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }

  async function predictOne(event) {
    event.preventDefault(); setBusy(true); setSingleResult(null); setStatus({ type: '', message: '' })
    try {
      const data = await readApi(await fetch(`${API}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_description: singleText }) }))
      setSingleResult(data)
      fetch(`${API}/analytics`).then(readApi).then(setAnalytics).catch(() => {})
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }

  async function correct(row) {
    const corrected = window.prompt(`Correct category for:\n${row.transaction_description}\n\nEnter the correct category:`)
    if (!corrected?.trim()) return
    try {
      await readApi(await fetch(`${API}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_description: row.transaction_description, predicted_category: row.predicted_category, corrected_category: corrected.trim() }) }))
      setStatus({ type: 'success', message: 'Correction saved for review. The model is not retrained automatically.' })
      fetch(`${API}/analytics`).then(readApi).then(setAnalytics).catch(() => {})
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
  }

  function downloadCsv() {
    const headers = ['transaction_description', 'predicted_category', 'confidence', 'amount', 'transaction_type', 'date', 'merchant']
    const csv = [headers.join(','), ...visibleRows.map(row => headers.map(key => `"${String(row[key] ?? '').replaceAll('"', '""')}"`).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'categorized-transactions.csv'; link.click(); URL.revokeObjectURL(url)
  }

  const navItems = [{ id: 'overview', label: 'Overview', icon: '◫' }, { id: 'ingestion', label: 'Upload & validate', icon: '⇧' }, { id: 'analysis', label: 'EDA & analytics', icon: '▥' }, { id: 'prediction', label: 'Predictions', icon: '✳' }, { id: 'model', label: 'Model performance', icon: '⌁' }]

  return <div className={`app-shell ${theme === 'light' ? 'theme-light' : 'theme-dark'}`} data-theme={theme}>
    <aside className="sidebar">
      <a className="brand" href="#overview" onClick={() => setActiveView('overview')}><span className="brand-symbol">L</span><span><b>LedgerLens</b><small>TRANSACTION INTELLIGENCE</small></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{navItems.map(item => <button key={item.id} className={`nav-link ${activeView === item.id ? 'active' : ''}`} onClick={() => setActiveView(item.id)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-note"><span className="privacy-icon">⌑</span><b>Privacy-minded by design</b><p>No bank login or credentials required. Upload only data you are authorized to use.</p></div><div className="sidebar-version">BANK TRANSACTION CATEGORIZER <span>v1.0 MVP</span></div></div>
    </aside>

    <div className="main-column">
      <header className="topbar"><div className="mobile-brand"><span className="brand-symbol">L</span><b>LedgerLens</b></div><div className="breadcrumb">Workspace <span>/</span> {navItems.find(x => x.id === activeView)?.label || 'Overview'}</div><div className="topbar-actions"><button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`} title={`Switch to ${theme === 'dark' ? 'day' : 'night'} mode`}><span>{theme === 'dark' ? '☀' : '☾'}</span>{theme === 'dark' ? 'Day mode' : 'Night mode'}</button><div className={`connection ${apiState}`}><i />{apiState === 'connected' ? 'API connected' : apiState === 'checking' ? 'Checking API' : 'API unavailable'}</div></div></header>
      <main className="content">
        <section className="page-heading"><div><p className="eyebrow">FINANCIAL DATA · NLP CLASSIFICATION</p><h1>{activeView === 'overview' ? 'Make your transactions make sense.' : navItems.find(x => x.id === activeView)?.label}</h1><p className="page-subtitle">{activeView === 'overview' ? 'A transparent workspace to validate, categorize and understand bank transaction descriptions.' : activeView === 'model' ? 'Review the available held-out evaluation metrics for the current TF-IDF baseline.' : 'Move from raw transaction text to useful, reviewable classification results.'}</p></div><div className="heading-model"><span className="model-glyph">₹</span><span><small>ACTIVE BASELINE</small><b>TF-IDF + Logistic Regression</b></span></div></section>

        {status.message && <div className={`notice ${status.type}`} role="status"><span>{status.type === 'success' ? '✓' : status.type === 'error' ? '!' : status.type === 'loading' ? '◌' : 'i'}</span>{status.message}</div>}

        {(activeView === 'overview' || activeView === 'model') && <section className="metric-grid" aria-label="Model and activity summary">
          <article className="metric-card"><span className="metric-label">PREDICTIONS IN THIS SESSION</span><b>{total.toLocaleString()}</b><small>Current uploaded dataset</small><span className="metric-mark">↗</span></article>
          <article className="metric-card"><span className="metric-label">AVERAGE CONFIDENCE</span><b>{total ? percent(averageConfidence) : '—'}</b><small>Current batch predictions</small><span className="metric-mark">◎</span></article>
          <article className="metric-card"><span className="metric-label">CATEGORIES DETECTED</span><b>{Object.keys(counts).length || '—'}</b><small>Predicted classes in this upload</small><span className="metric-mark">▦</span></article>
          <article className="metric-card"><span className="metric-label">ALL-TIME SAVED PREDICTIONS</span><b>{analytics?.total_predictions?.toLocaleString?.() ?? '—'}</b><small>Persisted in PostgreSQL</small><span className="metric-mark">◷</span></article>
        </section>}

        {(activeView === 'overview' || activeView === 'ingestion') && <section className="section-block" id="ingestion"><div className="section-title"><div><span className="section-index">01</span><div><h2>Dataset ingestion</h2><p>Upload a CSV and inspect its data quality before running inference.</p></div></div><span className="section-tag">CSV · MAX 25 MB</span></div>
          <div className="ingestion-grid"><div className={`surface upload-surface ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]) }}>
            <div className="surface-top"><div><span className="mini-label">DATASET</span><h3>Upload transactions</h3></div><span className="file-type">.CSV</span></div>
            <label className="dropzone"><input type="file" accept=".csv,text/csv" onChange={event => chooseFile(event.target.files?.[0] || null)} /><span className="upload-symbol">↑</span><b>{file ? file.name : 'Drop your CSV file here'}</b><small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · ready for validation` : 'or browse files from your device'}</small><span className="browse-link">Choose file</span></label>
            <div className="required-field">
  <span className="field-check">✓</span>
  <span>
    <b>Required information</b>
    <code>Transaction description</code>
  </span>
  <small>
    Accepted headers: Description, Narration, Particulars,
    Remarks or Transaction Description.
  </small>
</div>
            <button className="button button-primary full" onClick={uploadAndPredict} disabled={!file || busy}>{busy ? 'Processing dataset…' : 'Validate & categorize'}<span>→</span></button>
          </div>
          <div className="surface validation-surface"><span className="mini-label">VALIDATION CHECKLIST</span><h3>Data quality comes first</h3><p className="surface-copy">The API checks the required description column, empty datasets, missing descriptions, duplicate rows and upload limits before prediction.</p><div className="check-row"><span>01</span><b>File format & size</b><small>CSV · up to 25 MB</small></div><div className="check-row"><span>02</span><b>Transaction description</b><small>Flexible column names supported</small></div><div className="check-row"><span>03</span><b>Missing & duplicate rows</b><small>Warnings surfaced by API</small></div><div className="check-row"><span>04</span><b>Usable transaction text</b><small>Invalid rows are not inferred</small></div><div className="validation-footnote">Validation is performed by the backend; no quality result is assumed before upload.</div></div></div>
        </section>}

        {(activeView === 'overview' || activeView === 'prediction') && <section className="section-block" id="prediction"><div className="section-title"><div><span className="section-index">02</span><div><h2>Single transaction prediction</h2><p>Test one transaction description with the active baseline model.</p></div></div><span className="section-tag live-tag">LIVE INFERENCE</span></div><div className="surface prediction-surface"><form onSubmit={predictOne}><label className="mini-label" htmlFor="single-description">TRANSACTION DESCRIPTION</label><textarea id="single-description" value={singleText} onChange={event => setSingleText(event.target.value)} placeholder="e.g. UPI SWIGGY ORDER PAYMENT" required maxLength={2000}/><div className="form-footer"><small>Enter the transaction text only. Maximum 2,000 characters.</small><button className="button button-primary" disabled={busy || !singleText.trim()}>{busy ? 'Predicting…' : 'Predict category'}<span>→</span></button></div></form>
          {singleResult && <div className="prediction-result"><div className="result-main"><div><span className="mini-label">PREDICTED CATEGORY</span><h3>{singleResult.predicted_category}</h3></div><div className="result-confidence"><b>{percent(singleResult.confidence)}</b><small>{confidenceBand(singleResult.confidence).label} confidence</small></div></div><div className="confidence-track"><i className={confidenceBand(singleResult.confidence).className} style={{ width: `${Math.max(0, Math.min(100, singleResult.confidence * 100))}%` }}/></div><p className="evidence-note">Model evidence · influential positive text features. This is not a SHAP explanation or a causal reason.</p><div className="evidence-chips">{singleResult.explanation?.length ? singleResult.explanation.map(item => <span key={item.term}>{item.term} <b>{item.contribution > 0 ? '+' : ''}{item.contribution}</b></span>) : <small>No positive feature contributions were returned for this description.</small>}</div></div>}
        </div></section>}

        {(activeView === 'overview' || activeView === 'analysis') && <section className="section-block" id="spending-summary"><div className="section-title"><div><span className="section-index">03</span><div><h2>Spending & cash-flow summary</h2><p>Amounts are calculated from the uploaded file's amount and transaction_type columns.</p></div></div><span className="section-tag">CURRENT UPLOAD</span></div>
          {rows.length > 0 ? (financialSummary.amountRows > 0 ? <>
            <div className="money-kpi-grid">
              <article className="money-kpi debit-kpi"><span>TOTAL DEBIT · SPENT</span><b>{money(financialSummary.totalDebit)}</b><small>{financialSummary.debitRows.toLocaleString()} debit transactions</small></article>
              <article className="money-kpi credit-kpi"><span>TOTAL CREDIT · RECEIVED</span><b>{money(financialSummary.totalCredit)}</b><small>{financialSummary.creditRows.toLocaleString()} credit transactions</small></article>
              <article className="money-kpi"><span>NET CASH FLOW</span><b>{money(financialSummary.totalCredit - financialSummary.totalDebit)}</b><small>Credits minus debits</small></article>
            </div>
            <div className="money-analytics-grid">
              <div className="surface pie-surface"><div className="surface-top"><div><span className="mini-label">DEBIT BREAKDOWN</span><h3>Spending by category</h3></div><span className="chart-total">{money(financialSummary.totalDebit)} total</span></div>
                <div className="pie-layout"><div className="pie-chart" style={{background: pieGradient}} role="img" aria-label="Pie chart showing debit spending by predicted category"><div><small>TOTAL SPENT</small><b>{money(financialSummary.totalDebit)}</b></div></div><div className="pie-legend">{financialSummary.categories.filter(item => item.debit > 0).map((item) => { const index = financialSummary.categories.filter(x => x.debit > 0).findIndex(x => x.category === item.category); const share = financialSummary.totalDebit ? item.debit / financialSummary.totalDebit * 100 : 0; return <div className="pie-legend-row" key={item.category}><i style={{background: pieColors[index % pieColors.length]}}/><span>{item.category}</span><b>{share.toFixed(1)}%</b></div> })}</div></div>
              </div>
              <div className="surface category-money-surface"><div className="surface-top"><div><span className="mini-label">CATEGORY TOTALS</span><h3>Debit and credit by category</h3></div></div><div className="category-money-list">{financialSummary.categories.map(item => <div className="category-money-row" key={item.category}><div className="category-money-heading"><b>{item.category}</b><strong>{money(item.debit)} spent</strong></div><div className="money-mini-bars"><span className="debit-mini" style={{width: `${financialSummary.totalDebit ? item.debit / financialSummary.totalDebit * 100 : 0}%`}}/><span className="credit-mini" style={{width: `${financialSummary.totalCredit ? item.credit / financialSummary.totalCredit * 100 : 0}%`}}/></div><div className="category-money-meta"><span>Debit {money(item.debit)} · {item.debitCount} txns</span><span>Credit {money(item.credit)} · {item.creditCount} txns</span></div></div>)}</div><div className="money-legend"><span><i className="debit-key"/> Debit / spent</span><span><i className="credit-key"/> Credit / received</span></div></div>
            </div>
          </> : <div className="empty-state surface"><h3>Amount information unavailable</h3><p>This file contains no usable numeric amount values. Add an <code>amount</code> column to enable spending totals and charts.</p></div>) : <div className="empty-state surface"><h3>No financial totals yet</h3><p>Upload and categorize a CSV containing amount and transaction_type columns to calculate spending and credits.</p></div>}
        </section>}

        {(activeView === 'overview' || activeView === 'analysis') && <section className="section-block" id="analytics"><div className="section-title"><div><span className="section-index">03</span><div><h2>EDA & category distribution</h2><p>Explore the predicted classes from your current uploaded dataset.</p></div></div>{total > 0 && <button className="button button-quiet" onClick={downloadCsv}>↓ Export filtered CSV</button>}</div>
          {total > 0 ? <div className="analytics-grid"><div className="surface chart-surface"><div className="surface-top"><div><span className="mini-label">CURRENT DATASET</span><h3>Predictions by category</h3></div><span className="chart-total">{total.toLocaleString()} rows</span></div>{Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => <div className="bar-row" key={name}><span>{name}</span><div className="bar-track"><i style={{ width: `${Number(count) / maxCount * 100}%` }}/></div><b>{Number(count).toLocaleString()}</b></div>)}</div><div className="surface confidence-surface"><span className="mini-label">PREDICTION QUALITY SIGNAL</span><h3>Confidence overview</h3><div className="confidence-number">{percent(averageConfidence)}</div><p>Average model confidence for this batch. Confidence is not a guarantee of correctness.</p><div className="confidence-legend"><span><i className="dot high-dot"/>High &gt;80%</span><span><i className="dot medium-dot"/>Medium 50–80%</span><span><i className="dot low-dot"/>Low &lt;50%</span></div><div className="low-alert">{lowConfidenceCount.toLocaleString()} low-confidence predictions to review</div></div></div> : <div className="empty-state surface"><span className="empty-icon">▥</span><h3>Your analytics will appear here</h3><p>Upload and categorize a CSV to see category distribution and confidence summaries. No sample values are fabricated.</p><button className="button button-secondary" onClick={() => setActiveView('ingestion')}>Go to upload <span>→</span></button></div>}
          {total > 0 && <div className="surface table-surface"><div className="surface-top"><div><span className="mini-label">ROW-LEVEL REVIEW</span><h3>Categorized transactions</h3></div><span className="chart-total">{visibleRows.length.toLocaleString()} matching rows</span></div><div className="table-tools"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search transaction descriptions…" aria-label="Search transaction descriptions"/><select value={filter} onChange={event => setFilter(event.target.value)} aria-label="Filter by category"><option>All</option>{Object.keys(counts).sort().map(name => <option key={name}>{name}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>TRANSACTION DESCRIPTION</th><th>PREDICTED CATEGORY</th><th>AMOUNT</th><th>TYPE</th><th>CONFIDENCE</th><th>MODEL EVIDENCE</th><th>REVIEW</th></tr></thead><tbody>{visibleRows.slice(0, 500).map((row, index) => { const band = confidenceBand(row.confidence); return <tr key={`${index}-${row.transaction_description}`}><td className="description-cell">{row.transaction_description}</td><td><span className="category-pill">{row.predicted_category}</span></td><td>{row.amount != null ? money(row.amount) : '—'}</td><td><span className={`transaction-type-pill ${String(row.transaction_type || '').toLowerCase()}`}>{row.transaction_type || '—'}</span></td><td><span className={`confidence-pill ${band.className}`}>{percent(row.confidence)} · {band.label}</span></td><td className="evidence-cell">{row.explanation?.map(item => item.term).join(' · ') || '—'}</td><td><button className="review-button" onClick={() => correct(row)}>Correct</button></td></tr> })}</tbody></table>{visibleRows.length > 500 && <p className="table-note">Showing the first 500 matching rows. Export to download all filtered results.</p>}{visibleRows.length === 0 && <p className="table-note">No transactions match these filters.</p>}</div><p className="disclaimer">Predictions are automated classifications, not financial advice. Text-feature evidence indicates model influence, not causation. Corrections are stored for review and do not retrain the model automatically.</p></div>}
        </section>}

        {(activeView === 'overview' || activeView === 'model') && <section className="section-block" id="model"><div className="section-title"><div><span className="section-index">04</span><div><h2>Model performance & transparency</h2><p>Held-out evaluation metrics supplied with the trained baseline artifact.</p></div></div><span className="section-tag">BASELINE MODEL</span></div>
          <div className="model-grid"><div className="surface model-summary"><span className="mini-label">CURRENT MODEL</span><h3>TF-IDF + Logistic Regression</h3><p>Text classification using transaction descriptions. The model artifact includes preprocessing, vectorization and classifier components.</p><div className="model-facts"><span><small>Training rows</small><b>{metrics?.train_rows?.toLocaleString?.() ?? '—'}</b></span><span><small>Held-out test rows</small><b>{metrics?.test_rows?.toLocaleString?.() ?? '—'}</b></span><span><small>Training duration</small><b>{metrics?.training_seconds != null ? `${Number(metrics.training_seconds).toFixed(2)}s` : '—'}</b></span></div></div>
          <div className="surface metric-results"><span className="mini-label">HELD-OUT TEST METRICS</span><div className="performance-metric"><span>Accuracy</span><b>{metrics?.accuracy != null ? percent(metrics.accuracy) : '—'}</b></div><div className="performance-metric"><span>Macro F1</span><b>{metrics?.macro_f1 != null ? percent(metrics.macro_f1) : '—'}</b></div><div className="performance-metric"><span>Weighted F1</span><b>{metrics?.weighted_f1 != null ? percent(metrics.weighted_f1) : '—'}</b></div><p className="metrics-caveat">Dataset-specific evaluation results. They are not a guarantee of performance on real-world bank statements.</p></div></div>
          <div className="transparency-banner"><span>i</span><p><b>Explainability status:</b> The current API returns positive TF-IDF feature contributions from the linear model. This is model evidence, not SHAP. SHAP integration and Transformer-vs-baseline comparison are not present in this MVP and are not represented as completed.</p></div>
        </section>}
        <footer className="page-footer"><span>LEDGERLENS · BANK TRANSACTION CATEGORIZER</span><span>Classification support · Not financial advice</span></footer>
      </main>
    </div>
  </div>
}

export default App
