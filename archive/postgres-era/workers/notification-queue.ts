import { Queue } from 'bullmq';

let queue: Queue | null = null;

export function getNotificationQueue(redisUrl: string): Queue {
  if (!queue) {
    queue = new Queue('notifications', { connection: { url: redisUrl } });
  }
  return queue;
}
