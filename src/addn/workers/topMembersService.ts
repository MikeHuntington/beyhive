import workerpool from 'workerpool'
import { RichText } from '@atproto/api'
import dotenv from 'dotenv'

import { Canvas, Image, loadImage } from 'skia-canvas'
//import { createCanvas, Image, loadImage } from 'canvas'
import { AtpSessionData, BskyAgent, CredentialSession } from '@atproto/api'
import { TaskSessionData } from '../tasks/task'
import { createDb, Database, migrateToLatest } from '../../db/index.js'
import { NewMemberData } from '../tasks/newMemberTask'
import { MemberPoints } from '../../db/schema'

interface UserProfileInfo {
  handle: string
  avatar: string | undefined
}

function buildAgent(taskSession): BskyAgent {
  const creds = new CredentialSession(new URL('https://bsky.social'))
  const data: AtpSessionData = {
    accessJwt: taskSession.access,
    refreshJwt: taskSession.refresh,
    did: taskSession.did,
    handle: taskSession.handle,
    active: taskSession.active,
  }
  creds.resumeSession(data)

  // Rebuild Agent
  return new BskyAgent(creds)
}

function dataURLToUint8Array(dataURL: string): Uint8Array {
  const base64 = dataURL.split(',')[1] // Extract the base64 part
  const binaryString = atob(base64) // Decode the base64 string
  const len = binaryString.length
  const bytes = new Uint8Array(len)

  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return bytes
}

async function postTopMembers(
  taskSession: TaskSessionData,
  member: NewMemberData,
) {
  // Get agent
  const agent: BskyAgent = buildAgent(taskSession)

  const imgWidth = 1080
  const imgHeight = 1080
  let image1: Image
  let image2: Image = new Image()

  // Begin creating our image
  let canvas = new Canvas(imgWidth, imgHeight),
    { width, height } = canvas,
    ctx = canvas.getContext('2d')

  // Get Random base image
  const randomImg = Math.floor(Math.random() * 4) + 1
  image1 = await loadImage(`images/bey-top-members.png`)

  // Draw Base Image
  ctx.drawImage(image1, 0, 0, imgWidth, imgHeight)

  ctx.font = 'normal 800 22px serif'
  ctx.fillStyle = 'black'
  ctx.textAlign = 'left'

  // Setup Database
  dotenv.config()
  const db: Database = createDb(
    process.env.FEEDGEN_DB_LOCATION || '',
    process.env.CA_CERT || '',
  )

  // Get top members
  const topMembers: MemberPoints[] = await getTopMembers(db)

  const promises = topMembers.map(async (member) => {
    let avatar: Image | undefined = undefined
    // Get User Data
    const userProfile = await agent.app.bsky.actor.getProfile({
      actor: member.did,
    })

    //const handle = userProfile.data.handle
    //const avatar = userProfile.data.avatar

    //console.log('Top Member: ', handle)

    // Get member avatars
    if (userProfile.data.avatar) {
      avatar = await loadImage(userProfile.data.avatar)
    }

    return { userProfile: userProfile.data, avatar }
  })

  const profileResults = await Promise.all(promises)

  profileResults.forEach(({ userProfile: { handle }, avatar }, index) => {
    const offset: number = 350
    const padding: number = 125
    const position: number = padding * index

    ctx.fillText(`@${handle}`, 180, position + offset)

    const circle = {
      x: 120,
      y: position + offset,
      radius: 50,
    }

    if (avatar?.complete) {
      const aspect = 290 / 290

      // Shadow
      //ctx.shadowColor = 'black'
      //ctx.shadowBlur = 15

      ctx.save()
      ctx.beginPath()
      ctx.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2, true)
      ctx.closePath()
      ctx.clip()

      const hsx = circle.radius * Math.max(1.0 / aspect, 1.0)
      const hsy = circle.radius * Math.max(aspect, 1.0)

      ctx.drawImage(avatar, circle.x - hsx, circle.y - hsy, hsx * 2, hsy * 2)
      ctx.restore()
    }
  })

  //canvas.saveAsSync('images/top-members.png')

  return

  /*
  if (avatar) {
    image2 = await loadImage(avatar)
  }

  ctx.fillText(`@${handle}`, 520, 98)
  ctx.restore()

  const circle = {
    x: 280,
    y: 550,
    radius: 165,
  }

  if (image2.complete) {
    const aspect = 290 / 290

    // Shadow
    ctx.shadowColor = 'black'
    ctx.shadowBlur = 15

    ctx.save()
    ctx.beginPath()
    ctx.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2, true)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    ctx.save()
    ctx.beginPath()
    ctx.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2, true)
    ctx.closePath()
    ctx.clip()

    const hsx = circle.radius * Math.max(1.0 / aspect, 1.0)
    const hsy = circle.radius * Math.max(aspect, 1.0)

    ctx.drawImage(image2, circle.x - hsx, circle.y - hsy, hsx * 2, hsy * 2)
  }

  // finish drawing
  ctx.save()

  const image = await canvas.toDataURL('jpeg', { quality: 0.9 })
  const { data } = await agent.uploadBlob(dataURLToUint8Array(image))

  const rt = new RichText({
    text: `@${handle} ✨ Welcome to the BeyHive Interactive feed! 🐝`,
  })
  await rt.detectFacets(agent)

  await sendPost(agent, rt, data, imgWidth, imgHeight)

  return
  */
}

async function sendPost(
  agent: BskyAgent,
  richText: RichText,
  data: any,
  imgWidth: number,
  imgHeight: number,
) {
  await agent.post({
    text: richText?.text,
    facets: richText?.facets,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        // can be an array up to 4 values
        {
          alt: 'Welcome to #BeyHive', // the alt text
          image: data.blob,
          aspectRatio: {
            // a hint to clients
            width: imgWidth,
            height: imgHeight,
          },
        },
      ],
    },
    createdAt: new Date().toISOString(),
  })
}

async function getTopMembers(db: Database): Promise<MemberPoints[]> {
  const results = await db
    .selectFrom('member_points')
    .selectAll()
    .orderBy('points', 'desc')
    .limit(5)
    .execute()

  return results
}

// create a worker and register public functions
workerpool.worker({
  postTopMembers,
})
