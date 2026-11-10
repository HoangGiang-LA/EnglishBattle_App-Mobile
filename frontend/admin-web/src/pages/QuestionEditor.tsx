import { useEffect, useState } from 'react'
import { CheckCircle2, Headphones, Music2, Volume2, X } from 'lucide-react'
import { useAdmin } from '../context'
import { useResource } from '../hooks'
import { Badge, ErrorState, Field, FormError, Loading, Modal } from '../components'
import { message } from '../lib'
import { skillNames, skills, statusLabels } from '../domain'
import type {
  Catalog,
  ContentStatus,
  Difficulty,
  QuestionInput,
  QuestionRecord,
  SkillId,
} from '../domain'

export function QuestionEditor({
  question,
  onClose,
  catalogData,
}: {
  catalogData?: Catalog
  question?: QuestionRecord
  onClose: () => void
}) {
  const { api, toast } = useAdmin(),
    loadedCatalog = useResource(
      () => (catalogData ? Promise.resolve(catalogData) : api.catalog()),
      [catalogData],
    ),
    [busy, setBusy] = useState(false),
    [readingFile, setReadingFile] = useState(false),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'edit' | 'preview'>('edit'),
    [dirty, setDirty] = useState(false),
    [speaking, setSpeaking] = useState(false)
  // Reuse the parent snapshot so reloading it cannot unmount draft inputs.
  const catalog = catalogData
    ? { data: catalogData, loading: false, error: '', reload: loadedCatalog.reload }
    : loadedCatalog
  const [form, setForm] = useState<QuestionInput>(() =>
    question
      ? {
          categoryId: question.categoryId,
          topicId: question.topicId,
          lessonId: question.lessonId,
          prompt: question.prompt,
          options: question.options.map((o) => ({ ...o })),
          correctOptionId: question.correctOptionId,
          explanation: question.explanation,
          passage: question.passage,
          audioUrl: question.audioUrl,
          audioText: question.audioText,
          difficulty: question.difficulty,
          status: question.status,
        }
      : {
          categoryId: 'vocabulary',
          topicId: '',
          lessonId: '',
          prompt: '',
          options: [1, 2, 3, 4].map((n) => ({ id: `opt_${n}`, text: '' })),
          correctOptionId: '',
          explanation: '',
          passage: '',
          audioUrl: '',
          audioText: '',
          difficulty: 'easy',
          status: 'draft',
        },
  )
  useEffect(() => {
    if (!question && catalog.data && !form.topicId)
      setForm((f) => ({
        ...f,
        topicId: catalog.data!.topics.find((t) => t.categoryId === f.categoryId)?.id || '',
      }))
  }, [catalog.data, question, form.topicId])
  useEffect(
    () => () => {
      window.speechSynthesis?.cancel()
    },
    [],
  )
  const change = <K extends keyof QuestionInput>(key: K, value: QuestionInput[K]) => {
    setDirty(true)
    setForm((f) => ({ ...f, [key]: value }))
  }
  const close = () => {
    if (!dirty || window.confirm('Discard unsaved question changes?')) onClose()
  }
  const upload = async (file?: File) => {
    if (!file) return
    if (api.mode !== 'demo') {
      setError('Use an HTTPS audio URL. Storage upload is not available.')
      return
    }
    if (!file.type.startsWith('audio/')) {
      setError('Choose an audio file.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Choose an audio file smaller than 2 MB for this local preview.')
      return
    }
    setReadingFile(true)
    setError('')
    try {
      const audio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('The audio file could not be read.'))
        reader.readAsDataURL(file)
      })
      change('audioUrl', audio)
    } catch (e) {
      setError(message(e))
    } finally {
      setReadingFile(false)
    }
  }
  const speak = () => {
    if (!('speechSynthesis' in window)) {
      setError('Text-to-speech is unavailable in this browser.')
      return
    }
    if (speaking) {
      speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(form.audioText)
    utterance.lang = 'en-US'
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => {
      setSpeaking(false)
      setError('Could not play this text. Check your browser speech settings.')
    }
    speechSynthesis.speak(utterance)
    setSpeaking(true)
  }
  return (
    <Modal
      title={question ? 'Edit question' : 'Add question'}
      subtitle={
        question
          ? `${question.code} · Version ${question.version} · Saving creates a new version`
          : 'Build a question for your learning community'
      }
      onClose={close}
      wide
      busy={busy || readingFile}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy || readingFile) return
          setBusy(true)
          setError('')
          try {
            await api.saveQuestion(form, question?.id, question?.version)
            toast(question ? 'New question version saved.' : 'Question added.')
            onClose()
          } catch (e) {
            setError(message(e))
            setTab('edit')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="editor-tabs">
          <button
            type="button"
            className={tab === 'edit' ? 'selected' : ''}
            onClick={() => setTab('edit')}
          >
            Question details
          </button>
          <button
            type="button"
            className={tab === 'preview' ? 'selected' : ''}
            onClick={() => setTab('preview')}
          >
            Learner preview
          </button>
        </div>
        {catalog.loading ? (
          <Loading />
        ) : catalog.error ? (
          <ErrorState error={catalog.error} retry={catalog.reload} />
        ) : (
          <div className="modal-body question-editor">
            {tab === 'edit' ? (
              <>
                <div className="form-grid">
                  <Field label="Skill">
                    <select
                      value={form.categoryId}
                      onChange={(e) => {
                        const categoryId = e.target.value as SkillId
                        setDirty(true)
                        setForm((f) => ({
                          ...f,
                          categoryId,
                          topicId:
                            catalog.data?.topics.find((t) => t.categoryId === categoryId)?.id || '',
                          lessonId: '',
                        }))
                      }}
                    >
                      {skills.map((s) => (
                        <option key={s} value={s}>
                          {skillNames[s]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Topic">
                    <select
                      required
                      value={form.topicId}
                      onChange={(e) => {
                        change('topicId', e.target.value)
                        change('lessonId', '')
                      }}
                    >
                      <option value="">Select a topic</option>
                      {catalog.data?.topics
                        .filter((t) => t.categoryId === form.categoryId)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                            {t.status !== 'published' ? ` (${t.status})` : ''}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Lesson (optional)">
                    <select
                      value={form.lessonId}
                      onChange={(e) => change('lessonId', e.target.value)}
                    >
                      <option value="">No specific lesson</option>
                      {catalog.data?.lessons
                        .filter((l) => l.topicId === form.topicId)
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Difficulty">
                    <select
                      value={form.difficulty}
                      onChange={(e) => change('difficulty', e.target.value as Difficulty)}
                    >
                      {['easy', 'medium', 'hard'].map((d) => (
                        <option key={d} value={d}>
                          {statusLabels[d]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Question text">
                  <textarea
                    value={form.prompt}
                    onChange={(e) => change('prompt', e.target.value)}
                    rows={3}
                    minLength={5}
                    maxLength={3000}
                    required
                    placeholder="Write the question learners will see…"
                  />
                </Field>
                {form.categoryId === 'reading' && (
                  <Field label="Reading passage">
                    <textarea
                      value={form.passage}
                      onChange={(e) => change('passage', e.target.value)}
                      rows={5}
                      maxLength={10000}
                      placeholder="Add the passage for this reading question…"
                      required={form.status === 'published'}
                    />
                  </Field>
                )}
                {form.categoryId === 'listening' && (
                  <section className="audio-editor">
                    <h3>
                      <Headphones size={16} />
                      Listening content
                    </h3>
                    <Field
                      label="Text to read aloud"
                      hint="Used for speech playback when an audio file is not supplied."
                    >
                      <textarea
                        value={form.audioText}
                        onChange={(e) => change('audioText', e.target.value)}
                        rows={3}
                        maxLength={5000}
                      />
                    </Field>
                    <Field label="HTTPS audio URL">
                      <input
                        type="url"
                        placeholder="https://…"
                        value={form.audioUrl.startsWith('data:') ? '' : form.audioUrl}
                        onChange={(e) => change('audioUrl', e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Upload audio"
                      hint="Local demo only · max. 2 MB. Real uploads will need backend storage integration."
                    >
                      <input
                        type="file"
                        accept="audio/*"
                        disabled={readingFile || api.mode !== 'demo'}
                        onChange={(e) => {
                          void upload(e.target.files?.[0])
                          e.target.value = ''
                        }}
                      />
                    </Field>
                    {form.audioUrl && (
                      <div className="audio-preview">
                        <Music2 size={16} />
                        <span>
                          {form.audioUrl.startsWith('data:')
                            ? 'Local audio attachment'
                            : 'Linked audio'}
                        </span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remove audio"
                          onClick={() => change('audioUrl', '')}
                        >
                          <X size={15} />
                        </button>
                        <audio
                          controls
                          preload="none"
                          src={form.audioUrl}
                          onError={() =>
                            setError(
                              'This audio could not be played. Check the URL or upload another file.',
                            )
                          }
                        />
                      </div>
                    )}
                    {form.audioText && !form.audioUrl && (
                      <button type="button" className="btn" onClick={speak}>
                        <Volume2 size={15} />
                        {speaking ? 'Stop preview' : 'Listen to text'}
                      </button>
                    )}
                  </section>
                )}
                <fieldset className="answer-options">
                  <legend>
                    Answer options <small>Select the correct answer</small>
                  </legend>
                  {form.options.map((o, i) => (
                    <div
                      key={o.id}
                      className={`answer-option ${form.correctOptionId === o.id ? 'correct' : ''}`}
                    >
                      <label className="answer-radio">
                        <input
                          type="radio"
                          name="correct-answer"
                          value={o.id}
                          checked={form.correctOptionId === o.id}
                          onChange={() => change('correctOptionId', o.id)}
                          required
                          aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
                        />
                        <span>{String.fromCharCode(65 + i)}</span>
                      </label>
                      <input
                        aria-label={`Option ${String.fromCharCode(65 + i)} text`}
                        value={o.text}
                        onChange={(e) =>
                          change(
                            'options',
                            form.options.map((opt) =>
                              opt.id === o.id ? { ...opt, text: e.target.value } : opt,
                            ),
                          )
                        }
                        maxLength={500}
                        required
                        placeholder={`Answer option ${String.fromCharCode(65 + i)}`}
                      />
                      {form.correctOptionId === o.id && <CheckCircle2 size={16} />}
                    </div>
                  ))}
                </fieldset>
                <Field label="Answer explanation">
                  <textarea
                    value={form.explanation}
                    onChange={(e) => change('explanation', e.target.value)}
                    rows={3}
                    maxLength={3000}
                    required={form.status === 'published'}
                    placeholder="Explain why this answer is correct…"
                  />
                </Field>
                <Field label="Publication status">
                  <select
                    value={form.status}
                    onChange={(e) => change('status', e.target.value as ContentStatus)}
                  >
                    {['draft', 'published', 'archived'].map((s) => (
                      <option key={s} value={s}>
                        {statusLabels[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <div className="learner-preview">
                <div className="preview-label">
                  <Badge value={form.difficulty} />
                  <span>{skillNames[form.categoryId]} · 30 seconds</span>
                </div>
                {form.passage && form.categoryId === 'reading' && (
                  <blockquote>{form.passage}</blockquote>
                )}
                {form.categoryId === 'listening' && (
                  <>
                    {form.audioUrl ? (
                      <audio controls src={form.audioUrl} />
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={!form.audioText}
                        onClick={speak}
                      >
                        <Headphones size={16} />
                        {speaking ? 'Stop' : 'Play listening text'}
                      </button>
                    )}
                  </>
                )}
                <h3>{form.prompt || 'Your question will appear here'}</h3>
                {form.options.map((o, i) => (
                  <div className="preview-option" key={o.id}>
                    <span>{String.fromCharCode(65 + i)}</span>
                    {o.text || `Option ${String.fromCharCode(65 + i)}`}
                  </div>
                ))}
                <p className="muted small-text">
                  This preview hides the correct answer and explanation.
                </p>
              </div>
            )}
            <FormError error={error} />
          </div>
        )}
        <div className="modal-footer">
          <span className="muted small-text">
            {readingFile
              ? 'Reading audio file…'
              : api.mode === 'demo'
                ? 'Changes apply to local demo data only.'
                : 'Changes are saved through Firebase API.'}
          </span>
          <button className="btn" type="button" disabled={busy || readingFile} onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || readingFile || catalog.loading || !!catalog.error}
            onClick={(e) => {
              if (tab === 'preview') {
                e.preventDefault()
                setTab('edit')
              }
            }}
          >
            {busy ? 'Saving…' : tab === 'preview' ? 'Back to details' : 'Save question'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
