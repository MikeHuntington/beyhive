import { logger, task } from '@trigger.dev/sdk/v3'

export const sayHelloTask = task({
  id: 'say-hello',
  // Set an optional maxDuration to prevent tasks from running indefinitely
  maxDuration: 300, // Stop executing after 300 secs (5 mins) of compute
  run: async (payload: any, { ctx }) => {
    logger.log('Saying - Hello, world!', { payload, ctx })

    return {
      message: 'Hello, world!',
    }
  },
})
