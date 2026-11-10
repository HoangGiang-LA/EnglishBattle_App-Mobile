import { useState } from 'react'
import { Archive, BookOpen, Pencil, Plus, SlidersHorizontal } from 'lucide-react'
import { useAdmin } from '../context'
import { useDebounced, useResource } from '../hooks'
import {
  Badge,
  Empty,
  ErrorState,
  ExportButton,
  Field,
  FormError,
  Loading,
  Modal,
  Pagination,
  SearchInput,
} from '../components'
import { downloadCsv, message, number } from '../lib'
import { skillNames, skills, statusLabels } from '../domain'
import type { ContentInput, ContentStatus, Difficulty, QuestionRecord, SkillId } from '../domain'
import { QuestionEditor } from './QuestionEditor'

export function ContentPage({ initialSearch = '' }: { initialSearch?: string }) {
  const { api, toast, range } = useAdmin(),
    [tab, setTab] = useState('questions'),
    [search, setSearch] = useState(initialSearch),
    [category, setCategory] = useState(''),
    [status, setStatus] = useState(''),
    [difficulty, setDifficulty] = useState(''),
    [filters, setFilters] = useState(false),
    [page, setPage] = useState(1),
    [size, setSize] = useState(10)
  const [editor, setEditor] = useState<QuestionRecord | 'new' | null>(null),
    [archive, setArchive] = useState<QuestionRecord | null>(null),
    [contentEditor, setContentEditor] = useState<ContentInput | null>(null),
    [exporting, setExporting] = useState(false)
  const q = useDebounced(search),
    query = { q, categoryId: category, status, difficulty, page, pageSize: size }
  const questions = useResource(
      () => api.questions(query),
      [q, category, status, difficulty, page, size],
    ),
    catalog = useResource(() => api.catalog())
  const exportReport = async () => {
    setExporting(true)
    try {
      const report = await api.exportReport('questions', query, range)
      downloadCsv(report.filename, report.columns, report.rows)
      toast(
        api.mode === 'demo'
          ? 'Demo question report exported with the current filters.'
          : 'Question report exported with the current filters.',
      )
    } catch (e) {
      toast(message(e), true)
    } finally {
      setExporting(false)
    }
  }
  const isQuestions = tab === 'questions',
    singular = tab === 'skills' ? 'Skill' : tab === 'topics' ? 'Topic' : 'Lesson'
  const rows: ContentInput[] = catalog.data
    ? tab === 'skills'
      ? catalog.data.categories.map((c) => ({ ...c, title: c.name, kind: 'category' as const }))
      : tab === 'topics'
        ? catalog.data.topics.map((t) => ({ ...t, kind: 'topic' as const }))
        : catalog.data.lessons.map((l) => ({
            ...l,
            categoryId: catalog.data!.topics.find((t) => t.id === l.topicId)?.categoryId,
            kind: 'lesson' as const,
          }))
    : []
  const filteredRows = rows.filter(
    (row) =>
      (!search || `${row.title} ${row.id}`.toLowerCase().includes(search.toLowerCase())) &&
      (!category || (row.kind === 'category' ? row.id : row.categoryId) === category) &&
      (!status || row.status === status),
  )
  const contentSize = Math.ceil(filteredRows.length / size) || 1,
    contentPage = Math.min(page, contentSize),
    shownRows = filteredRows.slice((contentPage - 1) * size, contentPage * size)
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Question & Content</h1>
          <p>Manage your question bank and learning content.</p>
        </div>
      </div>
      <div className="content-tabs" role="tablist" aria-label="Content sections">
        {['questions', 'skills', 'topics', 'lessons'].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => {
              setTab(t)
              setSearch('')
              setStatus('')
              setPage(1)
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
            <span>
              {t === 'questions'
                ? (questions.data?.total ?? '—')
                : t === 'skills'
                  ? (catalog.data?.categories.length ?? '—')
                  : t === 'topics'
                    ? (catalog.data?.topics.length ?? '—')
                    : (catalog.data?.lessons.length ?? '—')}
            </span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          placeholder={
            isQuestions ? 'Search by question text or ID…' : `Search ${tab} by title or ID…`
          }
        />
        <select
          aria-label="Content skill"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setPage(1)
          }}
        >
          <option value="">All categories</option>
          {skills.map((s) => (
            <option value={s} key={s}>
              {catalog.data?.categories.find((c) => c.id === s)?.name || skillNames[s]}
            </option>
          ))}
        </select>
        <button
          className={`btn ${status || difficulty ? 'filter-active' : ''}`}
          aria-label="More content filters"
          aria-expanded={filters}
          onClick={() => setFilters((v) => !v)}
        >
          <SlidersHorizontal size={15} />
        </button>
        <span className="toolbar-spacer" />
        {isQuestions && <ExportButton busy={exporting} onClick={exportReport} />}
        {(isQuestions || tab !== 'skills') && (
          <button
            className="btn btn-primary"
            disabled={catalog.loading || !!catalog.error}
            onClick={() =>
              isQuestions
                ? setEditor('new')
                : setContentEditor({
                    kind: tab === 'topics' ? 'topic' : 'lesson',
                    title: '',
                    description: '',
                    status: 'draft',
                    categoryId: (category as SkillId) || 'vocabulary',
                    topicId:
                      catalog.data?.topics.find((t) => t.categoryId === (category || 'vocabulary'))
                        ?.id || '',
                  })
            }
          >
            <Plus size={16} />
            Add {isQuestions ? 'Question' : singular}
          </button>
        )}
      </div>
      {filters && (
        <div className="filter-bar">
          <Field label="Content status">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              <option value="">All statuses</option>
              {['draft', 'published', 'archived'].map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
          </Field>
          {isQuestions && (
            <Field label="Difficulty">
              <select
                value={difficulty}
                onChange={(e) => {
                  setDifficulty(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">All difficulties</option>
                {['easy', 'medium', 'hard'].map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button
            className="text-btn"
            onClick={() => {
              setStatus('')
              setCategory('')
              setDifficulty('')
              setSearch('')
              setPage(1)
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {isQuestions && catalog.error && <ErrorState error={catalog.error} retry={catalog.reload} />}
      {isQuestions ? (
        <section className="panel data-panel">
          <div className="panel-heading">
            <div className="heading-inline">
              <h2>All questions</h2>
              {questions.data && !questions.loading && (
                <span className="count-chip">{number(questions.data.total)}</span>
              )}
            </div>
            <span className="muted small-text">Newest updates first</span>
          </div>
          {questions.loading ? (
            <Loading />
          ) : questions.error ? (
            <ErrorState error={questions.error} retry={questions.reload} />
          ) : !questions.data?.items.length ? (
            <Empty
              title="No questions found"
              action={
                <button
                  className="btn"
                  onClick={() => {
                    setSearch('')
                    setCategory('')
                    setStatus('')
                    setDifficulty('')
                    setPage(1)
                  }}
                >
                  Clear search & filters
                </button>
              }
            />
          ) : (
            <>
              <div className="table-scroll">
                <table className="questions-table">
                  <thead>
                    <tr>
                      <th>Question ID</th>
                      <th>Question Text</th>
                      <th>Category</th>
                      <th>Difficulty</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.data.items.map((question) => (
                      <tr key={question.id}>
                        <td className="muted nowrap">{question.code}</td>
                        <td>
                          <button
                            className="question-link"
                            onClick={() => setEditor(question)}
                            title={question.prompt}
                          >
                            {question.prompt}
                          </button>
                          {question.status !== 'published' && (
                            <span className="question-state">
                              <Badge value={question.status} />
                            </span>
                          )}
                        </td>
                        <td className="muted">
                          {catalog.data?.categories.find((c) => c.id === question.categoryId)
                            ?.name || skillNames[question.categoryId]}
                        </td>
                        <td>
                          <Badge value={question.difficulty} />
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="icon-btn"
                              aria-label={`Edit ${question.code}`}
                              onClick={() => setEditor(question)}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              className="icon-btn danger"
                              aria-label={`Archive ${question.code}`}
                              disabled={question.status === 'archived'}
                              onClick={() => setArchive(question)}
                            >
                              <Archive size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={questions.data}
                label="questions"
                onPage={setPage}
                onSize={(s) => {
                  setSize(s)
                  setPage(1)
                }}
              />
            </>
          )}
        </section>
      ) : (
        <section className="panel data-panel">
          <div className="panel-heading">
            <div className="heading-inline">
              <h2>All {tab}</h2>
              <span className="count-chip">{number(filteredRows.length)}</span>
            </div>
            <span className="muted small-text">
              {tab === 'skills'
                ? 'Four learning skills · Idioms & Phrases belongs to Vocabulary'
                : 'Archive content to preserve existing references'}
            </span>
          </div>
          {catalog.loading ? (
            <Loading />
          ) : catalog.error ? (
            <ErrorState error={catalog.error} retry={catalog.reload} />
          ) : !filteredRows.length ? (
            <Empty title={`No ${tab} found`} />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{singular}</th>
                      <th>{tab === 'lessons' ? 'Topic' : 'Skill'}</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button className="question-link" onClick={() => setContentEditor(row)}>
                            {row.title}
                          </button>
                          <span className="record-id">{row.id}</span>
                        </td>
                        <td className="muted">
                          {tab === 'lessons'
                            ? catalog.data?.topics.find((t) => t.id === row.topicId)?.title
                            : skillNames[(row.categoryId || row.id) as SkillId]}
                        </td>
                        <td>
                          <Badge value={row.status} />
                        </td>
                        <td>
                          <button
                            className="icon-btn"
                            aria-label={`Edit ${row.title}`}
                            onClick={() => setContentEditor(row)}
                          >
                            <Pencil size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={{
                  items: shownRows,
                  page: contentPage,
                  pageSize: size,
                  total: filteredRows.length,
                }}
                label={tab}
                onPage={setPage}
                onSize={(s) => {
                  setSize(s)
                  setPage(1)
                }}
              />
            </>
          )}
        </section>
      )}
      <p className="metrics-note">
        <BookOpen size={13} />
        Question edits create a new version. Archived content stays available for historical
        references.
      </p>
      {editor && (
        <QuestionEditor
          catalogData={catalog.data || undefined}
          question={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      )}
      {archive && <ArchiveDialog question={archive} onClose={() => setArchive(null)} />}
      {contentEditor && (
        <ContentEditor input={contentEditor} onClose={() => setContentEditor(null)} />
      )}
    </>
  )
}
function ArchiveDialog({ question, onClose }: { question: QuestionRecord; onClose: () => void }) {
  const { api, toast } = useAdmin(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Modal
      title="Archive question?"
      subtitle={`${question.code} · Version ${question.version}`}
      onClose={onClose}
      busy={busy}
    >
      <div className="modal-body">
        <p>{question.prompt}</p>
        <p className="info-note">
          This question will no longer be available for new sessions. Its previous version is
          retained for existing sessions.
        </p>
        <FormError error={error} />
      </div>
      <div className="modal-footer">
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              await api.archiveQuestion(question.id, question.version)
              toast(
                api.mode === 'demo'
                  ? 'Question archived in the demo workspace.'
                  : 'Question archived.',
              )
              onClose()
            } catch (e) {
              setError(message(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Archiving…' : 'Archive question'}
        </button>
      </div>
    </Modal>
  )
}
function ContentEditor({ input, onClose }: { input: ContentInput; onClose: () => void }) {
  const { api, toast } = useAdmin(),
    [form, setForm] = useState(input),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    catalog = useResource(() => api.catalog())
  const set = <K extends keyof ContentInput>(key: K, value: ContentInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const kind = form.kind === 'category' ? 'skill' : form.kind,
    close = () => {
      if (
        JSON.stringify(form) === JSON.stringify(input) ||
        window.confirm('Discard unsaved content changes?')
      )
        onClose()
    }
  return (
    <Modal
      title={`${form.id ? 'Edit' : 'Add'} ${kind}`}
      subtitle="Learning content · local preview"
      onClose={close}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          setError('')
          try {
            await api.saveContent(form)
            toast(
              `${kind[0].toUpperCase() + kind.slice(1)} saved${api.mode === 'demo' ? ' in the demo workspace' : ''}.`,
            )
            onClose()
          } catch (e) {
            setError(message(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              minLength={2}
              maxLength={120}
              required
            />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              maxLength={2000}
            />
          </Field>
          {form.kind !== 'category' && (
            <Field label="Skill">
              <select
                value={form.categoryId || 'vocabulary'}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    categoryId: e.target.value as SkillId,
                    topicId:
                      catalog.data?.topics.find((t) => t.categoryId === e.target.value)?.id || '',
                  }))
                }
              >
                {skills.map((s) => (
                  <option value={s} key={s}>
                    {skillNames[s]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.kind === 'lesson' && (
            <>
              <Field label="Topic">
                <select
                  required
                  value={form.topicId}
                  onChange={(e) => set('topicId', e.target.value)}
                >
                  <option value="">Select a topic</option>
                  {catalog.data?.topics
                    .filter((t) => t.categoryId === (form.categoryId || 'vocabulary'))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Difficulty">
                <select
                  value={form.difficulty || 'easy'}
                  onChange={(e) => set('difficulty', e.target.value as Difficulty)}
                >
                  {['easy', 'medium', 'hard'].map((d) => (
                    <option key={d} value={d}>
                      {statusLabels[d]}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="Publication status">
            <select
              value={form.status}
              onChange={(e) => set('status', e.target.value as ContentStatus)}
            >
              {['draft', 'published', 'archived'].map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
          </Field>
          <FormError error={error} />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || catalog.loading}>
            {busy ? 'Saving…' : 'Save content'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
