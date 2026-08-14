import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  BskyAgent,
  RichText,
  AppBskyEmbedVideo,
  AppBskyVideoDefs,
  AppBskyEmbedExternal,
  AtpAgent,
  BlobRef,
} from '@atproto/api';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import sharp from 'sharp';
import { Plug } from '@gitroom/helpers/decorators/plug.decorator';
import { timer } from '@gitroom/helpers/utils/timer';
import axios from 'axios';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

async function reduceImageBySize(url: string, maxSizeKB = 976) {
  try {
    // Fetch the image from the URL
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    let imageBuffer = Buffer.from(response.data);

    // Use sharp to get the metadata of the image
    const metadata = await sharp(imageBuffer).metadata();
    let width = metadata.width!;
    let height = metadata.height!;

    // Resize iteratively until the size is below the threshold
    while (imageBuffer.length / 1024 > maxSizeKB) {
      width = Math.floor(width * 0.9); // Reduce dimensions by 10%
      height = Math.floor(height * 0.9);

      // Resize the image
      const resizedBuffer = await sharp(imageBuffer)
        .resize({ width, height })
        .toBuffer();

      imageBuffer = resizedBuffer;

      if (width < 10 || height < 10) break; // Prevent overly small dimensions
    }

    return { width, height, buffer: imageBuffer };
  } catch (error) {
    console.error('Error processing image:', error);
    throw error;
  }
}

async function uploadVideo(
  agent: AtpAgent,
  videoPath: string
): Promise<AppBskyEmbedVideo.Main> {
  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Date.now() / 1000 + 60 * 30, // 30 minutes
  });

  // The video is never buffered in memory: the size comes from a HEAD request
  // and the bytes are streamed straight from the source into the upload.
  const headResponse = await fetch(videoPath, {
    method: 'HEAD',
    // identity encoding so content-length matches the bytes the GET streams
    headers: { 'accept-encoding': 'identity' },
    // @ts-ignore - undici-only option; blocks SSRF to internal IPs
    dispatcher: getSsrfSafeDispatcher(),
  });
  const videoSize = Number(headResponse.headers.get('content-length') || 0);
  if (!headResponse.ok || !videoSize) {
    throw new BadBody(
      'bluesky',
      '{}',
      {} as any,
      'Could not determine the video size for Bluesky upload'
    );
  }

  const videoResponse = await fetch(videoPath, {
    headers: { 'accept-encoding': 'identity' },
    // @ts-ignore - undici-only option; blocks SSRF to internal IPs
    dispatcher: getSsrfSafeDispatcher(),
  });
  if (!videoResponse.ok || !videoResponse.body) {
    throw new Error(`Failed to fetch video: ${videoResponse.statusText}`);
  }

  console.log('Uploading video', videoPath, videoSize);

  const uploadUrl = new URL(
    'https://video.bsky.app/xrpc/app.bsky.video.uploadVideo'
  );
  uploadUrl.searchParams.append('did', agent.session!.did);
  uploadUrl.searchParams.append('name', videoPath.split('/').pop()!);

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceAuth.token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': videoSize.toString(),
    },
    body: videoResponse.body,
    // Required by undici when streaming a request body.
    duplex: 'half',
  } as any);

  const jobStatus = (await uploadResponse.json()) as AppBskyVideoDefs.JobStatus;
  console.log('JobId:', jobStatus.jobId);
  let blob: BlobRef | undefined = jobStatus.blob;
  const videoAgent = new AtpAgent({ service: 'https://video.bsky.app' });

  let attempts = 0;
  const maxAttempts = 18; // ~9 minutes at 30s interval
  while (!blob) {
    if (attempts++ >= maxAttempts) {
      throw new BadBody(
        'bluesky',
        JSON.stringify({}),
        {} as any,
        'Video upload timed out, job did not complete'
      );
    }

    const { data: status } = await videoAgent.app.bsky.video.getJobStatus({
      jobId: jobStatus.jobId,
    });
    console.log(
      'Status:',
      status.jobStatus.state,
      status.jobStatus.progress || ''
    );
    if (status.jobStatus.blob) {
      blob = status.jobStatus.blob;
    }

    if (status.jobStatus.state === 'JOB_STATE_FAILED') {
      throw new BadBody(
        'bluesky',
        JSON.stringify({}),
        {} as any,
        'Could not upload video, job failed'
      );
    }

    await timer(30000);
  }

  console.log('posting video...');

  return {
    $type: 'app.bsky.embed.video',
    video: blob,
  } satisfies AppBskyEmbedVideo.Main;
}

interface OpenGraphData {
  title: string;
  description: string;
  image?: string;
}

async function fetchOpenGraphData(url: string): Promise<OpenGraphData | null> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Postiz/1.0; +https://postiz.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });

    const html = response.data as string;

    const getMetaContent = (property: string): string | undefined => {
      const ogMatch = html.match(
        new RegExp(
          `<meta[^>]*property=["']og:${property}["'][^>]*content=["']([^"']*)["']`,
          'i'
        )
      ) ||
        html.match(
          new RegExp(
            `<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${property}["']`,
            'i'
          )
        );
      if (ogMatch) return ogMatch[1];

      const twitterMatch = html.match(
        new RegExp(
          `<meta[^>]*name=["']twitter:${property}["'][^>]*content=["']([^"']*)["']`,
          'i'
        )
      ) ||
        html.match(
          new RegExp(
            `<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:${property}["']`,
            'i'
          )
        );
      if (twitterMatch) return twitterMatch[1];

      if (property === 'description') {
        const descMatch = html.match(
          /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i
        ) ||
          html.match(
            /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i
          );
        if (descMatch) return descMatch[1];
      }

      return undefined;
    };

    let title = getMetaContent('title');
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : url;
    }

    const description = getMetaContent('description') || '';
    const image = getMetaContent('image');

    return {
      title: title.substring(0, 300),
      description: description.substring(0, 1000),
      image,
    };
  } catch (error) {
    console.error('Error fetching Open Graph data:', error);
    return null;
  }
}

function extractFirstUrl(text: string): string | null {
  const urlRegex = /https?:\/\/[^\s<>\[\]()]+/gi;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

async function createExternalEmbed(
  agent: BskyAgent,
  url: string
): Promise<AppBskyEmbedExternal.Main | null> {
  const ogData = await fetchOpenGraphData(url);
  if (!ogData) return null;

  let thumbBlob: BlobRef | undefined;

  if (ogData.image) {
    try {
      let imageUrl = ogData.image;
      if (imageUrl.startsWith('//')) {
        imageUrl = 'https:' + imageUrl;
      } else if (imageUrl.startsWith('/')) {
        const urlObj = new URL(url);
        imageUrl = urlObj.origin + imageUrl;
      }

      const { buffer } = await reduceImageBySize(imageUrl);
      const uploadResponse = await agent.uploadBlob(new Blob([buffer]));
      thumbBlob = uploadResponse.data.blob;
    } catch (error) {
      console.error('Error uploading thumbnail for embed card:', error);
    }
  }

  return {
    $type: 'app.bsky.embed.external',
    external: {
      uri: url,
      title: ogData.title,
      description: ogData.description,
      ...(thumbBlob ? { thumb: thumbBlob } : {}),
    },
  } satisfies AppBskyEmbedExternal.Main;
}

@Rules(
  'Bluesky can have maximum 1 video or 4 pictures in one post, it can also be without attachments'
)
export class BlueskyProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 2; // Bluesky has moderate rate limits
  identifier = 'bluesky';
  name = 'Bluesky';
  toolTip = "We don’t currently support two-factor authentication. If it’s enabled on Bluesky, you’ll need to disable it."
  isBetweenSteps = false;
  scopes = ['write:statuses', 'profile', 'write:media'];
  editor = 'normal' as const;
  maxLength() {
    return 300;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>
  ): Promise<string | true> {
    if (
      posts?.some(
        (p) =>
          p?.some((a) => (a?.path?.indexOf?.('mp4') ?? -1) > -1) &&
          (p?.length ?? 0) > 1
      )
    ) {
      return 'You can only upload one video per post.';
    }

    if (posts?.some((p) => (p?.length ?? 0) > 4)) {
      return 'There can be maximum 4 pictures in a post.';
    }
    return true;
  }

  async customFields() {
    return [
      {
        key: 'service',
        label: 'Service',
        defaultValue: 'https://bsky.social',
        validation: `/^(https?:\\/\\/)?((([a-zA-Z0-9\\-_]{1,256}\\.[a-zA-Z]{2,6})|(([0-9]{1,3}\\.){3}[0-9]{1,3}))(:[0-9]{1,5})?)(\\/[^\\s]*)?$/`,
        type: 'text' as const,
      },
      {
        key: 'identifier',
        label: 'Identifier',
        validation: `/^.+$/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        label: 'Password',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = JSON.parse(Buffer.from(params.code, 'base64').toString());

    // Bluesky talks to a user-supplied service URL via BskyAgent (not our
    // `this.fetch`), so the undici SSRF dispatcher can't intercept it. Validate
    // the URL here — the connection chokepoint — so an internal/private address
    // can never be saved as an integration. Opt-out matches the dispatcher env.
    if (
      process.env.DISABLE_SSRF_PROTECTION !== 'true' &&
      !(await isSafePublicHttpsUrl(body.service))
    ) {
      return 'Invalid service URL: must be a public HTTPS address';
    }

    try {
      const agent = new BskyAgent({
        service: body.service,
      });

      const {
        data: { accessJwt, refreshJwt, handle, did },
      } = await agent.login({
        identifier: body.identifier,
        password: body.password,
      });

      const profile = await agent.getProfile({
        actor: did,
      });

      return {
        refreshToken: refreshJwt,
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: accessJwt,
        id: did,
        name: profile.data.displayName!,
        picture: profile?.data?.avatar || '',
        username: profile.data.handle!,
      };
    } catch (e) {
      console.log(e);
      return 'Invalid credentials';
    }
  }

  private async getAgent(integration: Integration) {
    const body = JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );
    const agent = new BskyAgent({
      service: body.service,
    });

    try {
      await agent.login({
        identifier: body.identifier,
        password: body.password,
      });
    } catch (err) {
      throw new RefreshToken('bluesky', JSON.stringify(err), {} as BodyInit);
    }

    return agent;
  }

  private async uploadMediaForPost(
    agent: BskyAgent,
    post: PostDetails
  ): Promise<{ embed: any; images: any[] }> {
    // Separate images and videos
    const imageMedia =
      post.media?.filter((p) => !hasExtension(p.path, 'mp4')) || [];
    const videoMedia =
      post.media?.filter((p) => hasExtension(p.path, 'mp4')) || [];

    // Upload images
    const images = await Promise.all(
      imageMedia.map(async (p) => {
        const { buffer, width, height } = await reduceImageBySize(p.path);
        return {
          width,
          height,
          buffer: await agent.uploadBlob(new Blob([buffer])),
        };
      })
    );

    // Upload videos (only one video per post is supported by Bluesky)
    let videoEmbed: AppBskyEmbedVideo.Main | null = null;
    if (videoMedia.length > 0) {
      videoEmbed = await uploadVideo(agent, videoMedia[0].path);
    }

    // Determine embed based on media types
    let embed: any = {};
    if (videoEmbed) {
      embed = videoEmbed;
    } else if (images.length > 0) {
      embed = {
        $type: 'app.bsky.embed.images',
        images: images.map((p, index) => ({
          alt: imageMedia?.[index]?.alt || '',
          image: p.buffer.data.blob,
          aspectRatio: {
            width: p.width,
            height: p.height,
          },
        })),
      };
    } else {
      // No media — check for URLs to create a link preview embed card
      const firstUrl = extractFirstUrl(firstPost.message);
      if (firstUrl) {
        const externalEmbed = await createExternalEmbed(agent, firstUrl);
        if (externalEmbed) {
          embed = externalEmbed;
        }
      }
    }

    return { embed, images };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const agent = await this.getAgent(integration);
    const [firstPost] = postDetails;

    const { embed } = await this.uploadMediaForPost(agent, firstPost);

    const rt = new RichText({
      text: firstPost.message,
    });

    await rt.detectFacets(agent);

    // @ts-ignore
    const { cid, uri, commit } = await agent.post({
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      ...(Object.keys(embed).length > 0 ? { embed } : {}),
    });

    return [
      {
        id: firstPost.id,
        postId: uri,
        status: 'completed',
        releaseURL: `https://bsky.app/profile/${id}/post/${uri.split('/').pop()}`,
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const agent = await this.getAgent(integration);
    const [commentPost] = postDetails;

    const { embed } = await this.uploadMediaForPost(agent, commentPost);

    const rt = new RichText({
      text: commentPost.message,
    });

    await rt.detectFacets(agent);

    // Get the parent post info to get its CID
    const parentUri = lastCommentId || postId;

    // Fetch the parent post to get its CID
    const parentThread = await agent.getPostThread({
      uri: parentUri,
      depth: 0,
    });

    // @ts-ignore
    const parentCid = parentThread.data.thread.post?.cid;
    // @ts-ignore
    const rootUri = parentThread.data.thread.post?.record?.reply?.root?.uri || postId;
    // @ts-ignore
    const rootCid = parentThread.data.thread.post?.record?.reply?.root?.cid || parentCid;

    // @ts-ignore
    const { cid, uri, commit } = await agent.post({
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      ...(Object.keys(embed).length > 0 ? { embed } : {}),
      reply: {
        root: {
          uri: rootUri,
          cid: rootCid,
        },
        parent: {
          uri: parentUri,
          cid: parentCid,
        },
      },
    });

    return [
      {
        id: commentPost.id,
        postId: uri,
        status: 'completed',
        releaseURL: `https://bsky.app/profile/${id}/post/${uri.split('/').pop()}`,
      },
    ];
  }

  @Plug({
    identifier: 'bluesky-autoRepostPost',
    title: 'Auto Repost Posts',
    description:
      'When a post reached a certain number of likes, repost it to increase engagement (1 week old posts)',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
    ],
  })
  async autoRepostPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string }
  ) {
    const body = JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );
    const agent = new BskyAgent({
      service: body.service,
    });

    await agent.login({
      identifier: body.identifier,
      password: body.password,
    });

    const getThread = await agent.getPostThread({
      uri: id,
      depth: 0,
    });

    // @ts-ignore
    if (getThread.data.thread.post?.likeCount >= +fields.likesAmount) {
      await timer(2000);
      await agent.repost(
        // @ts-ignore
        getThread.data.thread.post?.uri,
        // @ts-ignore
        getThread.data.thread.post?.cid
      );
      return true;
    }

    return true;
  }

  @Plug({
    identifier: 'bluesky-autoPlugPost',
    title: 'Auto plug post',
    description:
      'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    const body = JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );
    const agent = new BskyAgent({
      service: body.service,
    });

    await agent.login({
      identifier: body.identifier,
      password: body.password,
    });

    const getThread = await agent.getPostThread({
      uri: id,
      depth: 0,
    });

    // @ts-ignore
    if (getThread.data.thread.post?.likeCount >= +fields.likesAmount) {
      await timer(2000);
      const rt = new RichText({
        text: stripHtmlValidation('normal', fields.post, true),
      });

      await agent.post({
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
        reply: {
          root: {
            // @ts-ignore
            uri: getThread.data.thread.post?.uri,
            // @ts-ignore
            cid: getThread.data.thread.post?.cid,
          },
          parent: {
            // @ts-ignore
            uri: getThread.data.thread.post?.uri,
            // @ts-ignore
            cid: getThread.data.thread.post?.cid,
          },
        },
      });
      return true;
    }

    return true;
  }

  override async mention(
    token: string,
    d: { query: string },
    id: string,
    integration: Integration
  ) {
    const body = JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );

    const agent = new BskyAgent({
      service: body.service,
    });

    await agent.login({
      identifier: body.identifier,
      password: body.password,
    });

    const list = await agent.searchActors({
      q: d.query,
    });

    return list.data.actors.map((p) => ({
      label: p.displayName,
      id: p.handle,
      image: p.avatar,
    }));
  }

  mentionFormat(idOrHandle: string, name: string) {
    return `@${idOrHandle}`;
  }
}
