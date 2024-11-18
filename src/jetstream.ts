import WebSocket from 'ws'
import { Jetstream } from '@skyware/jetstream'
import { Database } from './db/index.js'
import { BskyAgent } from '@atproto/api'
import { AuthorTask } from './addn/tasks/authorTask.js'
import { BannedTask } from './addn/tasks/bannedTask.js'
import { NewMemberTask } from './addn/tasks/newMemberTask.js'
import { CleanupTask } from './addn/tasks/cleanupTask.js'
import { BotCommandTask } from './addn/tasks/botCommandTask.js'

function removeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export class JetStreamManager {
  private authorTask = new AuthorTask()
  private bannedTask = new BannedTask()
  private cleanupTask = new CleanupTask()
  private botCommandTask = new BotCommandTask()
  private newMemberTask = new NewMemberTask()
  private db: Database
  public jetstream: Jetstream

  // Init
  async init(db: Database) {
    this.db = db

    // Login Agent
    const agent = new BskyAgent({ service: 'https://bsky.social' })
    const handle = `${process.env.BOT_HANDLE}`
    const password = `${process.env.BOT_PASSWORD}`

    await agent.login({ identifier: handle, password }).then(async () => {
      // Run Tasks
      this.authorTask.run(1 * 60 * 1000, agent)
      this.bannedTask.run(10 * 60 * 1000, agent)
      this.cleanupTask.run(24 * 60 * 60 * 1000, this.db)
      this.botCommandTask.run(2 * 1000, agent)
      this.newMemberTask.run(2 * 1000, agent)
    })

    this.initJetstream()
  }

  initJetstream() {
    // Jetstream
    this.jetstream = new Jetstream({
      ws: WebSocket,
      wantedCollections: ['app.bsky.feed.post'], // omit to receive all collections
      //wantedDids: ['did:plc:dvej7nvbmmusifxfeund54cz'], // omit to receive events from all dids
    })

    this.jetstream.onCreate(
      'app.bsky.feed.post',
      this.handleCreateEvent.bind(this),
    )
    this.jetstream.onDelete(
      'app.bsky.feed.post',
      this.handleDeleteEvent.bind(this),
    )

    this.jetstream.start()
  }

  async handleCreateEvent({ commit: { record, rkey, cid }, did }) {
    const uri = `at://${did}/app.bsky.feed.post/${rkey}`
    const author: string = did
    let hashtags: any[] = []
    let newJoin: boolean = false
    let isMember: boolean = false

    // Ignore banned members
    if (this.bannedTask.bannedMembers.includes(author)) {
      console.log('This author is banned: ', author)
      return
    }

    // Filter for posts that include the join/leave hashtags
    record['text']
      ?.toLowerCase()
      ?.match(/#[^\s#\.\;]*/gim)
      ?.map((hashtag) => {
        hashtags.push(hashtag)
      })

    // Let the bot handle posts
    this.handleBotMessages(uri, record, rkey, did, hashtags)

    // Add the Author
    if (hashtags.includes('#joinbeyhive')) {
      if (this.authorTask.addAuthor(author)) {
        this.newMemberTask.addMember(author)
        newJoin = true
      } else {
        return
      }
    }

    // Remove the Author
    if (hashtags.includes('#leavebeyhive')) {
      if (this.authorTask.Authors.includes(author)) {
        this.authorTask.removeAuthor(author)
      }
      return
    }

    // Check if this is a reply (if it is, don't process)
    if (record.hasOwnProperty('reply')) {
      return
    }

    if (
      !this.authorTask.Authors.includes(author) &&
      !newJoin &&
      process.env.LIMIT_NON_AUTHORS === 'true'
    ) {
      // Only allow if there's a #BEYHIVE hashtag
      if (!hashtags.includes('#beyhive')) {
        return
      }
    } else {
      if (this.authorTask.Authors.includes(author)) {
        isMember = true
      }
    }

    // only beyonce/beyhive posts
    const re =
      /^(?!.*(beyboons|haghive|hasbeyn)).*\b(beyhive|beyoncé|beyonce|sasha fierce|yonce)\b.*$/imu

    let match = false

    let matchString = record['text'].toLowerCase()

    const normalizedString = removeAccents(matchString)

    if (normalizedString.match(re) !== null) {
      match = true
    }

    if (!match) return

    const post = {
      uri,
      cid: cid,
      indexedAt: new Date().toISOString(),
    }

    console.log('Committing message to DB: ', post)

    await this.db
      .insertInto('post')
      .values([post])
      .onConflict((oc) => oc.doNothing())
      .execute()

    // Increment points for members
    if (isMember) {
      await this.db
        .insertInto('member_points')
        .values([{ did: author, points: 0 }])
        .onConflict((oc) =>
          oc.column('did').doUpdateSet({
            points: (eb) => eb('member_points.points', '+', 1),
          }),
        )
        .execute()
    }

    return
  }

  async handleDeleteEvent(event) {
    await this.db
      .deleteFrom('post')
      .where('uri', 'in', [
        `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`,
      ])
      .execute()
  }

  handleBotMessages(
    uri: string,
    record: any,
    rkey: any,
    did: string,
    hashtags: any[],
  ) {
    const botId = process.env.BOT_PUBLISHER_DID
    if (record.reply?.parent?.uri?.includes(`at://${botId}`)) {
      // Is a bot reply
      console.log('BOT got a reply')

      // POINTS COMMAND
      if (hashtags.includes('#points')) {
        this.botCommandTask.addCommand({
          type: 'points',
          userDid: did,
        })
        return
      }
    } else if (
      this.is('app.bsky.embed.record', record.embed) &&
      record.embed.record.uri.includes(`at://${botId}`)
    ) {
      // Is a bot quote
    } else if (
      this.is('app.bsky.embed.recordWithMedia', record.embed) &&
      record.embed.record.record.uri.includes(`at://${botId}`)
    ) {
      // Is a bot quote
    } else if (
      record.facets?.some((facet) =>
        facet.features.some(
          (feature) =>
            this.is('app.bsky.richtext.facet#mention', feature) &&
            feature.did === botId,
        ),
      )
    ) {
      // Is a mention
      console.log('BOT got a mention')
    }
  }

  is(lexicon, obj) {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      '$type' in obj &&
      (obj.$type === lexicon || obj.$type === lexicon + '#main')
    )
  }
}
