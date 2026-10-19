// Botonera: app de Slack para mandar sonidos a un canal privado.
//
// /slack/comando   → /sonido [nombre | borrar nombre]; solo, abre la ventana con buscador
// /slack/acciones  → botones de la botonera y el buscador de la ventana
// /slack/opciones  → lo que muestra el buscador mientras se escribe
// /slack/eventos   → MP3 nuevos, reacción 🔊, bienvenida y pestaña Inicio
// /receptor/conectar     → WebSocket del receptor de escritorio (clave de /sonido receptor)
// /receptor/audio/<slug> → el audio de un sonido (clave KV "sound:<slug>"), para que el receptor lo guarde
//
// Un MP3 que sube una persona al canal es un sonido nuevo: se guarda en KV, así
// no depende de la retención de Slack. Un audio que publica el bot es un envío, y
// es lo único que reproducen los receptores. Solo usan la botonera los miembros
// del canal.

import { DurableObject } from 'cloudflare:workers'

interface Env {
  BOT_TOKEN: string
  SIGNING_SECRET: string
  CHANNEL_ID: string
  SOUNDS: KVNamespace
  HUB: DurableObjectNamespace<Receptores>
}

type Sound = { key: string; name: string }
type SoundMeta = { name: string; filename: string; mimetype: string; by: string; at: number }

type SlackFile = { id: string; name: string; title?: string; mimetype?: string; size?: number; url_private_download?: string }
type SlackAnswer = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } } & Record<string, unknown>
type SlackEvent = {
  type: string
  user?: string
  bot_id?: string
  channel?: string
  text?: string
  ts?: string
  files?: SlackFile[]
  reaction?: string
  item?: { channel?: string }
  tab?: string
}

const CACHE_MS = 60_000
const BUTTONS_PER_ROW = 5
const MAX_BYTES = 2 * 1024 * 1024
const OPEN_REACTION = 'loud_sound'
const NO_ACCESS = 'No tenés acceso a la Botonera: pedí que te sumen al canal.'

// Lo que ve quien se suma al canal, y /sonido ayuda.
const GUIDE = [
  '*🔊 Bienvenida a la Botonera*',
  '',
  '*Mandar un sonido*',
  '• `/sonido` abre la botonera con buscador: elegís un sonido y se manda. (Enter dos veces: el primero cierra el menú de Slack)',
  '• `/sonido nombre` lo manda directo, por ejemplo `/sonido pefeto`',
  '• Reaccioná con :loud_sound: a cualquier mensaje del canal y te aparece la grilla',
  '• La pestaña *Inicio* de la app Botonera tiene la botonera siempre a mano',
  '',
  '*Agregar y sacar sonidos*',
  '• Subí un MP3 al canal con su nombre en el mensaje (hasta 2 MB, mejor de pocos segundos)',
  '• `/sonido borrar nombre` lo saca de la botonera',
  '',
  '*Que suene solo en tu compu*',
  '• `/sonido receptor` te da una clave para el receptor de escritorio',
  '',
  'Cada sonido sale con tu nombre. Esta guía: `/sonido ayuda`.',
].join('\n')

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/receptor/')) return onReceptor(request, env, pathname)
    if (request.method !== 'POST') return new Response('Botonera')

    const body = await request.text()
    if (!(await isFromSlack(request, body, env.SIGNING_SECRET))) return new Response('firma inválida', { status: 401 })

    // Slack espera respuesta en 3 s y si no reintenta: se contesta ya, el trabajo
    // sigue en segundo plano, y los reintentos se ignoran.
    if (request.headers.get('x-slack-retry-num')) return new Response('')

    if (pathname === '/slack/comando') {
      const form = new URLSearchParams(body)
      const command = { userId: form.get('user_id') ?? '', text: form.get('text') ?? '', responseUrl: form.get('response_url') ?? '', triggerId: form.get('trigger_id') ?? '' }
      ctx.waitUntil(onCommand(env, command))
      return new Response('')
    }
    if (pathname === '/slack/acciones') {
      const payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '{}')
      if (payload.type === 'block_actions') ctx.waitUntil(onPress(env, payload))
      return new Response('')
    }
    // El buscador de la ventana pide las opciones mientras se escribe: esto sí se
    // contesta en el momento, con lo que coincide.
    if (pathname === '/slack/opciones') {
      const payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '{}')
      const query = normalize(payload.value ?? '')
      const options = (await listSounds(env))
        .filter(sound => normalize(sound.name).includes(query))
        .slice(0, 100)
        .map(sound => ({ text: { type: 'plain_text', text: sound.name.slice(0, 75) }, value: sound.key }))
      return Response.json({ options })
    }
    if (pathname === '/slack/eventos') {
      const payload = JSON.parse(body)
      if (payload.type === 'url_verification') return new Response(payload.challenge)
      if (payload.event) ctx.waitUntil(onEvent(env, payload.event))
      return new Response('')
    }
    return new Response('no encontrado', { status: 404 })
  },
}

// --- Slack -----------------------------------------------------------------------

async function isFromSlack(request: Request, body: string, secret: string) {
  const timestamp = request.headers.get('x-slack-request-timestamp')
  const signature = request.headers.get('x-slack-signature')
  if (!secret || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`))
  const expected = `v0=${[...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`

  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

async function slack(env: Env, method: string, params: Record<string, unknown> = {}) {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BOT_TOKEN}` },
    body: form,
  })
  const answer = (await response.json()) as SlackAnswer
  if (!answer.ok) throw new Error(`${method}: ${answer.error ?? response.status}`)
  return answer
}

async function reply(responseUrl: string, text: string, blocks?: unknown[]) {
  if (!responseUrl) return
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text, blocks }),
  })
}

function explain(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// --- Miembros (con caché corta por instancia) -------------------------------------------

let members = { at: 0, ids: new Set<string>() }
let botUserId = ''

async function memberIds(env: Env) {
  if (Date.now() - members.at > CACHE_MS) {
    const ids = new Set<string>()
    let cursor = ''
    do {
      const answer = await slack(env, 'conversations.members', { channel: env.CHANNEL_ID, limit: '1000', cursor: cursor || undefined })
      for (const id of answer.members as string[]) ids.add(id)
      cursor = answer.response_metadata?.next_cursor ?? ''
    } while (cursor)
    members = { at: Date.now(), ids }
  }
  return members.ids
}

async function isMember(env: Env, userId: string) {
  return (await memberIds(env)).has(userId)
}

async function isBot(env: Env, event: SlackEvent) {
  if (event.bot_id) return true
  if (!botUserId) botUserId = (await slack(env, 'auth.test')).user_id as string
  return event.user === botUserId
}

// --- Sonidos (KV) -------------------------------------------------------------------

let sounds = { at: 0, list: [] as Sound[] }

function normalize(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function keyOf(name: string) {
  return `sound:${normalize(name).replace(/ /g, '-')}`
}

async function listSounds(env: Env) {
  if (Date.now() - sounds.at > CACHE_MS) {
    const list: Sound[] = []
    let cursor: string | undefined
    do {
      const page = await env.SOUNDS.list<SoundMeta>({ prefix: 'sound:', cursor })
      for (const key of page.keys) list.push({ key: key.name, name: key.metadata?.name ?? key.name.slice(6) })
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    sounds = { at: Date.now(), list: list.sort((a, b) => a.name.localeCompare(b.name, 'es')) }
  }
  return sounds.list
}

function findSound(list: Sound[], text: string) {
  const query = normalize(text)
  return list.find(one => normalize(one.name) === query) ?? list.find(one => normalize(one.name).includes(query))
}

// Un MP3 subido por una persona: se baja de Slack y se guarda con su nombre.
async function addSounds(env: Env, event: SlackEvent) {
  const audios = (event.files ?? []).filter(file => file.mimetype?.startsWith('audio/'))
  if (audios.length === 0) return

  const lines: string[] = []
  for (const file of audios) {
    const label = audios.length === 1 && event.text?.trim() ? event.text.trim() : file.title || file.name
    const name = label.replace(/\.[a-z0-9]{2,4}$/i, '').trim()
    try {
      if (!normalize(name)) throw new Error('le falta un nombre: escribilo en el mensaje del MP3')
      if ((file.size ?? 0) > MAX_BYTES) throw new Error('pesa más de 2 MB: recortalo a unos segundos')
      if (!file.url_private_download) throw new Error('Slack no dio el archivo para bajar')
      const audio = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${env.BOT_TOKEN}` } })
      if (!audio.ok) throw new Error(`no pude bajarlo (${audio.status})`)
      const bytes = await audio.arrayBuffer()
      if (bytes.byteLength > MAX_BYTES) throw new Error('pesa más de 2 MB: recortalo a unos segundos')

      const key = keyOf(name)
      const existed = (await listSounds(env)).some(one => one.key === key)
      const meta: SoundMeta = { name, filename: file.name, mimetype: file.mimetype ?? 'audio/mpeg', by: event.user ?? '', at: Date.now() }
      await env.SOUNDS.put(key, bytes, { metadata: meta })
      sounds.at = 0
      lines.push(`✅ ${existed ? 'reemplazado' : 'agregado'}: *${name}*`)
    } catch (err) {
      lines.push(`❌ *${name || file.name}*: ${explain(err)}`)
    }
  }
  await slack(env, 'chat.postMessage', { channel: event.channel, thread_ts: event.ts, text: lines.join('\n') })
}

async function sendSound(env: Env, sound: Sound, userId: string) {
  const stored = await env.SOUNDS.getWithMetadata<SoundMeta>(sound.key, 'arrayBuffer')
  if (!stored.value) throw new Error('ese sonido ya no está')

  const filename = stored.metadata?.filename ?? `${sound.name}.mp3`
  const slot = await slack(env, 'files.getUploadURLExternal', { filename, length: String(stored.value.byteLength) })
  const uploaded = await fetch(slot.upload_url as string, { method: 'POST', body: stored.value })
  if (!uploaded.ok) throw new Error(`no pude subir el sonido (${uploaded.status})`)

  await slack(env, 'files.completeUploadExternal', {
    files: [{ id: slot.file_id, title: sound.name }],
    channel_id: env.CHANNEL_ID,
    initial_comment: `🔊 *${sound.name}* · enviado por <@${userId}>`,
  })

  // Que suene en los receptores; si el aviso falla, el sonido igual quedó en el canal.
  const message = { type: 'sonido', key: sound.key, name: sound.name, at: stored.metadata?.at ?? 0, by: userId }
  await hub(env)
    .fetch('https://hub/avisar', { method: 'POST', body: JSON.stringify({ members: [...(await memberIds(env))], message }) })
    .catch(err => console.error(`aviso a receptores: ${explain(err)}`))
}

// --- Botonera (Block Kit) -------------------------------------------------------------

function grid(list: Sound[]) {
  if (list.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: 'Todavía no hay sonidos: subí un MP3 al canal con su nombre en el mensaje.' } }]
  }
  const rows = []
  for (let i = 0; i < list.length; i += BUTTONS_PER_ROW) {
    rows.push({
      type: 'actions',
      elements: list.slice(i, i + BUTTONS_PER_ROW).map(sound => ({
        type: 'button',
        text: { type: 'plain_text', text: sound.name.slice(0, 75), emoji: true },
        action_id: sound.key,
        value: sound.key,
      })),
    })
  }
  return [{ type: 'header', text: { type: 'plain_text', text: '🔊 Botonera', emoji: true } }, ...rows]
}

// --- Handlers ---------------------------------------------------------------------------

// La ventana: un buscador que manda apenas se elige y, abajo, los botones. Tras
// cada envío se redibuja con la confirmación y el buscador vacío (un block_id
// nuevo es lo que lo vacía).
function modal(list: Sound[], sent?: string) {
  return {
    type: 'modal',
    callback_id: 'botonera',
    title: { type: 'plain_text', text: 'Botonera' },
    close: { type: 'plain_text', text: 'Cerrar' },
    blocks: [
      {
        type: 'section',
        block_id: `buscar-${Date.now()}`,
        text: { type: 'mrkdwn', text: '*Buscá y mandá*' },
        accessory: {
          type: 'external_select',
          action_id: 'buscar',
          min_query_length: 0,
          placeholder: { type: 'plain_text', text: 'Escribí parte del nombre' },
        },
      },
      ...(sent ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ Mandaste *${sent}*` }] }] : []),
      { type: 'divider' },
      ...grid(list).filter(block => block.type !== 'header'),
    ],
  }
}

// Avisa solo a esa persona: en la respuesta del comando o botón, o en el canal si no hay.
async function tell(env: Env, userId: string, responseUrl: string, text: string) {
  if (responseUrl) return reply(responseUrl, text)
  await slack(env, 'chat.postEphemeral', { channel: env.CHANNEL_ID, user: userId, text })
}

type Command = { userId: string; text: string; responseUrl: string; triggerId: string }

async function onCommand(env: Env, { userId, text, responseUrl, triggerId }: Command) {
  try {
    if (!(await isMember(env, userId))) return reply(responseUrl, NO_ACCESS)
    const list = await listSounds(env)
    const query = text.trim()

    if (!query) {
      try {
        await slack(env, 'views.open', { trigger_id: triggerId, view: modal(list) })
      } catch {
        // La ventana se abre solo dentro de los 3 s del comando; si no llega, la grilla.
        await reply(responseUrl, 'Botonera', grid(list))
      }
      return
    }

    if (normalize(query) === 'receptor') return reply(responseUrl, await newReceptorKey(env, userId))
    if (normalize(query) === 'ayuda') return reply(responseUrl, GUIDE)

    const removal = /^borrar\s+(.+)$/i.exec(query)
    if (removal) {
      const sound = list.find(one => normalize(one.name) === normalize(removal[1] ?? ''))
      if (!sound) return reply(responseUrl, `No hay ningún sonido que se llame "${removal[1]}".`)
      await env.SOUNDS.delete(sound.key)
      sounds.at = 0
      return reply(responseUrl, `🗑️ Borré *${sound.name}* de la botonera.`)
    }

    const sound = findSound(list, query)
    if (!sound) return reply(responseUrl, `No encontré "${query}". Escribí /sonido solo para ver la lista.`)
    await sendSound(env, sound, userId)
    return reply(responseUrl, `🔊 Mandé *${sound.name}*`)
  } catch (err) {
    return reply(responseUrl, `No pude: ${explain(err)}`)
  }
}

type PressPayload = {
  user: { id: string }
  response_url?: string
  view?: { id: string }
  actions: { value?: string; selected_option?: { value: string } }[]
}

async function onPress(env: Env, payload: PressPayload) {
  const action = payload.actions[0]
  const sent = await sendByKey(env, payload.user.id, action?.selected_option?.value ?? action?.value, payload.response_url ?? '')
  if (sent && payload.view) {
    await slack(env, 'views.update', { view_id: payload.view.id, view: modal(await listSounds(env), sent) }).catch(() => {})
  }
}

// Devuelve el nombre del sonido mandado, o nada si no se pudo (y ya avisó por qué).
async function sendByKey(env: Env, userId: string, key: string | undefined, responseUrl: string) {
  try {
    if (!(await isMember(env, userId))) return void (await tell(env, userId, responseUrl, NO_ACCESS))
    const sound = (await listSounds(env)).find(one => one.key === key)
    if (!sound) return void (await tell(env, userId, responseUrl, 'Ese sonido ya no está en la botonera.'))
    await sendSound(env, sound, userId)
    return sound.name
  } catch (err) {
    await tell(env, userId, responseUrl, `No pude mandar el sonido: ${explain(err)}`).catch(() => {})
  }
}

async function onEvent(env: Env, event: SlackEvent) {
  try {
    if (event.type === 'app_home_opened' && event.tab === 'home' && event.user) {
      await publishHome(env, event.user)
    } else if (event.type === 'message' && event.channel === env.CHANNEL_ID && event.files && !(await isBot(env, event))) {
      await addSounds(env, event)
    } else if (event.type === 'member_joined_channel' && event.channel === env.CHANNEL_ID && event.user && !(await isBot(env, event))) {
      members.at = 0
      await slack(env, 'chat.postEphemeral', { channel: env.CHANNEL_ID, user: event.user, text: GUIDE })
    } else if (event.type === 'reaction_added' && event.reaction === OPEN_REACTION && event.item?.channel === env.CHANNEL_ID && event.user) {
      if (!(await isMember(env, event.user))) return
      await slack(env, 'chat.postEphemeral', { channel: env.CHANNEL_ID, user: event.user, text: 'Botonera', blocks: grid(await listSounds(env)) })
    }
  } catch (err) {
    console.error(`evento ${event.type}: ${explain(err)}`)
  }
}

async function publishHome(env: Env, userId: string) {
  const blocks = (await isMember(env, userId))
    ? [
        ...grid(await listSounds(env)),
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Cada botón manda el sonido al canal con tu nombre. Todos los comandos: `/sonido ayuda`.' }] },
      ]
    : [{ type: 'section', text: { type: 'mrkdwn', text: NO_ACCESS } }]
  await slack(env, 'views.publish', { user_id: userId, view: { type: 'home', blocks } })
}

// --- Receptores de escritorio --------------------------------------------------------
// Cada persona pide su clave con /sonido receptor y la pega una vez en el receptor.
// Una clave nueva anula la anterior. Sin ser miembro del canal, la clave no sirve.

async function newReceptorKey(env: Env, userId: string) {
  const random = new Uint8Array(24)
  crypto.getRandomValues(random)
  const key = [...random].map(byte => byte.toString(16).padStart(2, '0')).join('')

  const previous = await env.SOUNDS.get(`receptor-de:${userId}`)
  if (previous) await env.SOUNDS.delete(`receptor:${previous}`)
  await env.SOUNDS.put(`receptor:${key}`, userId)
  await env.SOUNDS.put(`receptor-de:${userId}`, key)

  return [
    'Tu clave del receptor (es personal, no la compartas):',
    `\`${key}\``,
    'Copiala y en el receptor tocá *Pegar clave*. Si pedís otra, esta deja de andar.',
  ].join('\n')
}

async function receptorUser(env: Env, request: Request) {
  const key = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!/^[0-9a-f]{48}$/.test(key)) return null
  return env.SOUNDS.get(`receptor:${key}`)
}

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('hub'))
}

async function onReceptor(request: Request, env: Env, pathname: string) {
  const userId = await receptorUser(env, request)
  if (!userId) return new Response('clave inválida', { status: 401 })
  if (!(await isMember(env, userId))) return new Response('sin acceso al canal', { status: 403 })

  if (pathname === '/receptor/conectar') {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('se espera un WebSocket', { status: 426 })
    const forwarded = new Request('https://hub/conectar', request)
    forwarded.headers.set('x-user', userId)
    return hub(env).fetch(forwarded)
  }

  const audio = /^\/receptor\/audio\/([a-z0-9-]+)$/.exec(pathname)
  if (audio) {
    const stored = await env.SOUNDS.getWithMetadata<SoundMeta>(`sound:${audio[1]}`, 'arrayBuffer')
    if (!stored.value) return new Response('no existe', { status: 404 })
    return new Response(stored.value, { headers: { 'content-type': stored.metadata?.mimetype ?? 'audio/mpeg' } })
  }
  return new Response('no encontrado', { status: 404 })
}

// Un solo hub con todas las conexiones. Hiberna entre avisos: una conexión quieta
// no gasta nada, y el "ping" de los receptores se contesta sin despertarlo.
export class Receptores extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/conectar') {
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server!, [request.headers.get('x-user') ?? ''])
      return new Response(null, { status: 101, webSocket: client })
    }
    if (pathname === '/avisar') {
      const { members, message } = (await request.json()) as { members: string[]; message: unknown }
      const allowed = new Set(members)
      const text = JSON.stringify(message)
      for (const socket of this.ctx.getWebSockets()) {
        const [user] = this.ctx.getTags(socket)
        if (user && allowed.has(user)) socket.send(text)
        else socket.close(4003, 'sin acceso al canal')
      }
      return new Response('ok')
    }
    return new Response('no encontrado', { status: 404 })
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason)
  }
}
