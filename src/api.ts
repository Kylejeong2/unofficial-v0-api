import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  enableCaching: true,
  verbose: 1,
});

const COOKIE_FILE = 'cookies.json';

const PromptSchema = z.object({
  prompt: z.string(),
});

// type PromptRequest = z.infer<typeof PromptSchema>;

interface ObserveAction {
  description: string;
  selector?: string;
}

async function saveCookies(page: any) {
  const cookies = await page.context().cookies();
  await fs.writeFile(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

async function loadCookies(page: any) {
  try {
    const cookieData = await fs.readFile(COOKIE_FILE, 'utf-8');
    const cookies = JSON.parse(cookieData);
    await page.context().addCookies(cookies);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkAndLogin(page: any) {
  // Check if we need to login
  const actions = await page.observe() as ObserveAction[];
  const needsLogin = actions.some(action => 
    action.description.toLowerCase().includes('sign in') || 
    action.description.toLowerCase().includes('login')
  );

  if (needsLogin) {
    // Click login/sign in button
    await page.act({ action: "click the sign in button" });

    // Wait for GitHub auth option and click it
    await page.act({ action: "click sign in with github" });

    // Fill GitHub credentials if needed
    if (process.env.GITHUB_EMAIL && process.env.GITHUB_PASSWORD) {
      await page.act({ 
        action: "enter %email% into the email field",
        variables: { email: process.env.GITHUB_EMAIL }
      });
      await page.act({ 
        action: "enter %password% into the password field",
        variables: { password: process.env.GITHUB_PASSWORD }
      });
      await page.act({ action: "click the sign in button" });
    }

    // Save cookies after successful login
    await saveCookies(page);
    return true;
  }
  return false;
}

async function captureScreenshot(page: any, name: string) {
  const screenshot = await page.screenshot({
    type: 'png',
    fullPage: true
  });
  const base64Image = screenshot.toString('base64');
  return base64Image;
}

async function extractAllFiles(page: any) {
  // Get all file tabs
  const actions = await page.observe() as ObserveAction[];
  const fileTabs = actions.filter(action => 
    action.description.toLowerCase().includes('tab') || 
    action.description.toLowerCase().includes('file')
  );

  const files: Record<string, string> = {};

  // Extract code from each tab
  for (const tab of fileTabs) {
    // Click the tab
    await page.act({ action: `click ${tab.description}` });

    // Extract the code
    const fileContent = await page.extract({
      instruction: "extract the code from the current file",
      schema: z.object({
        filename: z.string(),
        code: z.string()
      })
    });

    files[fileContent.filename] = fileContent.code;
  }

  return files;
}

async function interactWithV0(prompt: string) {
  await stagehand.init();
  const page = stagehand.page;

  try {
    // Navigate to v0.dev
    await page.goto('https://v0.dev');

    // Try to restore cookies first
    const cookiesLoaded = await loadCookies(page);
    if (!cookiesLoaded) {
      await checkAndLogin(page);
    }

    // Wait for and fill the prompt
    await page.act({ 
      action: "enter %prompt% into the prompt textarea",
      variables: {
        prompt
      }
    });

    await page.act({ 
      action: "click the Generate button" 
    });

    // Wait for generation to complete (might be something else)
    await page.waitForSelector('.completed-indicator', { timeout: 120000 });

    // Capture IDE screenshot
    const ideScreenshot = await captureScreenshot(page, 'ide');

    // Extract all files
    const files = await extractAllFiles(page);

    // Switch to preview tab and capture screenshot
    await page.act({ action: "click the Preview tab" });
    const previewScreenshot = await captureScreenshot(page, 'preview');

    return {
      files,
      ideScreenshot,
      previewScreenshot
    };

  } finally {
    await stagehand.close();
  }
}

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/api/prompt', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { prompt } = PromptSchema.parse(request.body);
      const result = await interactWithV0(prompt);
      return result;
    } catch (error) {
      console.error('Error:', error);
      reply.status(500).send({ error: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  });
}
