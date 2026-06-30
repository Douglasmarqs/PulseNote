// BookVerse — Cloud Functions
//
// Documento 11 — Segurança / Documento 10 — Cloud Functions.
//
// Esta é a primeira função do projeto: "onBookProgressUpdate". Ela observa
// toda atualização em users/{userId}/books/{bookId} e, sempre que detecta
// avanço de página (ou conclusão de livro), calcula e grava server-side:
//   - users/{userId}.stats.pagesRead       (total de páginas lidas)
//   - users/{userId}.stats.streakCount     (sequência de dias lendo)
//   - users/{userId}.stats.lastReadDate    (última data com leitura)
//   - users/{userId}.stats.booksFinished   (livros concluídos)
//   - users/{userId}/readingLog/{data}     (páginas lidas naquele dia)
//
// Por que isso roda aqui e não no app: o Admin SDK usado em Cloud
// Functions ignora as regras do Firestore (firestore.rules) — então é o
// único lugar em que dá pra confiar que o valor gravado em "stats" reflete
// avanço de página real, em vez de um valor digitado direto no console do
// navegador. As regras do Firestore bloqueiam explicitamente qualquer
// escrita do cliente nesses campos (ver firestore.rules).
//
// Limitação conhecida (documentada, não escondida): a data "de hoje" usada
// aqui é calculada em UTC, pelo relógio do servidor da função — não pelo
// fuso horário do usuário. Pertinho da meia-noite, isso pode fazer uma
// leitura tarde da noite (horário de Brasília) contar para "o dia
// seguinte" do ponto de vista do streak. Resolver isso de forma robusta
// exigiria salvar o fuso horário do usuário no perfil e ainda está fora do
// escopo desta primeira versão.

const { onDocumentUpdated } = require('firebase-functions/v2/firestore')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

initializeApp()
const db = getFirestore()

// Proteção extra: mesmo com a validação de currentPage <= totalPages já
// existindo nas regras do Firestore, um livro cadastrado com totalPages
// absurdamente alto ainda poderia gerar um "delta" grande demais numa
// única atualização. Este teto evita que isso infle as estatísticas de
// forma desproporcional.
const MAX_PAGES_PER_UPDATE = 3000

function formatDateId(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function getTodayId() {
  return formatDateId(new Date())
}

function getYesterdayId() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return formatDateId(d)
}

exports.onBookProgressUpdate = onDocumentUpdated('users/{userId}/books/{bookId}', async (event) => {
  const before = event.data.before.data()
  const after = event.data.after.data()
  const { userId } = event.params

  const beforePage = Number(before.currentPage) || 0
  const afterPage = Number(after.currentPage) || 0
  const justFinished = after.status === 'concluido' && before.status !== 'concluido'

  let delta = afterPage - beforePage
  if (delta <= 0 && !justFinished) {
    // Página não avançou e o livro não foi concluído agora — nada para
    // registrar (ex: usuário editou só o título, ou diminuiu a página por
    // engano e corrigiu, etc.).
    return
  }
  if (delta < 0) delta = 0
  if (delta > MAX_PAGES_PER_UPDATE) delta = MAX_PAGES_PER_UPDATE

  const today = getTodayId()
  const yesterday = getYesterdayId()

  const userRef = db.collection('users').doc(userId)
  const logRef = userRef.collection('readingLog').doc(today)

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef)
    if (!userSnap.exists) return // perfil não encontrado — nada a fazer

    const stats = userSnap.data().stats || {}
    const lastReadDate = stats.lastReadDate
    const currentStreak = stats.streakCount || 0

    const updates = {}

    if (delta > 0) {
      let newStreak
      if (lastReadDate === today) {
        newStreak = currentStreak || 1
      } else if (lastReadDate === yesterday) {
        newStreak = currentStreak + 1
      } else {
        newStreak = 1
      }

      updates['stats.pagesRead'] = FieldValue.increment(delta)
      updates['stats.streakCount'] = newStreak
      updates['stats.lastReadDate'] = today
    }

    if (justFinished) {
      updates['stats.booksFinished'] = FieldValue.increment(1)
    }

    if (Object.keys(updates).length > 0) {
      tx.update(userRef, updates)
    }

    if (delta > 0) {
      tx.set(logRef, { date: today, pagesRead: FieldValue.increment(delta) }, { merge: true })
    }
  })
})
