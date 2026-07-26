export const prerender = false;
import { json } from '@sveltejs/kit';
import { latestVersion } from '$lib/server/releaseNotes';

export async function GET() {
  return json({
    status: 'success',
    customData: { latestVersion, membershipLevel: 'free' }
  });
}
