import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';

dotenv.config();

const COOKIE_FILE = 'cookies.json';
const MAX_GENERATION_TIME = 180000; // 3 minutes

// Initialize Stagehand with stored cookies
async function initStagehand() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    enableCaching: true,
    verbose: 1,
  });

  await stagehand.init();
  await loadCookies(stagehand.page);
  return stagehand;
}

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

      // Wait a moment for the login to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify login was successful by checking for login-related elements again
      const postLoginActions = await page.observe() as ObserveAction[];
      const stillNeedsLogin = postLoginActions.some(action => 
        action.description.toLowerCase().includes('sign in') || 
        action.description.toLowerCase().includes('login')
      );

      if (!stillNeedsLogin) {
        // Only save cookies if login was successful
        await saveCookies(page);
        return true;
      } else {
        throw new Error('Login failed - still seeing login elements after attempt');
      }
    }

    return false;
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

async function waitForGeneration(page: any) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < MAX_GENERATION_TIME) {
    const actions = await page.observe() as ObserveAction[];
    
    // Check for error states
    const hasError = actions.some(action => 
      action.description.toLowerCase().includes('error') ||
      action.description.toLowerCase().includes('failed')
    );
    if (hasError) {
      throw new Error('Generation failed');
    }

    // Check for completion indicators
    const isComplete = actions.some(action => {
      const desc = action.description.toLowerCase();
      return (
        desc.includes('copy code') ||
        desc.includes('preview') ||
        desc.includes('download') ||
        desc.includes('save to project')
      );
    });

    if (isComplete) {
      return true;
    }

    // Check if still generating
    const isGenerating = actions.some(action => {
      const desc = action.description.toLowerCase();
      return (
        desc.includes('generating') ||
        desc.includes('loading') ||
        desc.includes('please wait')
      );
    });

    if (!isGenerating) {
      // Additional verification - try to extract code
      try {
        const result = await page.extract({
          instruction: "check if there's any code visible in the editor",
          schema: z.object({
            hasCode: z.boolean()
          })
        });
        if (result.hasCode) {
          return true;
        }
      } catch (e) {
        // If extraction fails, continue waiting
      }
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Generation timed out');
}

async function extractCode(page: any) {
  // First check if code tab exists
  const actions = await page.observe() as ObserveAction[];
  const hasCodeTab = actions.some(action => 
    action.description.toLowerCase().includes('code') && 
    (action.selector?.includes('@[17rem]/tabs:block') || 
     action.selector?.includes('span') ||
     action.description.toLowerCase().includes('tab'))
  );

  if (!hasCodeTab) {
    throw new Error('No code tab found - generation may have failed');
  }

  // Click the code tab
  await page.act({ action: "click the tab that says Code" });

  // Wait a moment for code view to load
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Extract the code by evaluating the page content
  const result = await page.evaluate(() => {
    // Look for pre elements containing code
    const codeBlocks = Array.from(document.querySelectorAll('pre'));
    return codeBlocks.map(block => ({
      filename: block.getAttribute('data-filename') || '',
      code: block.textContent || ''
    }));
  });

  // Format the result
  const files: Record<string, string> = {};
  for (const block of result) {
    if (block.code.trim()) {
      files[block.filename || 'code.tsx'] = block.code;
    }
  }

  return files;
}

async function interactWithV0(prompt: string) {
  const stagehand = await initStagehand();
  const page = stagehand.page;

  try {
    // Navigate to v0.dev
    await page.goto('https://v0.dev');

    // Check if we need to login (cookies might be expired or invalid)
    const actions = await page.observe() as ObserveAction[];
    const needsLogin = actions.some(action => 
      action.description.toLowerCase().includes('sign in') || 
      action.description.toLowerCase().includes('login')
    );

    if (needsLogin) {
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

    // Wait for generation to complete using observe
    await waitForGeneration(page);

    // Capture IDE screenshot
    // const ideScreenshot = await captureScreenshot(page, 'ide');

    // Extract code
    const files = await extractCode(page);

    // Save the latest cookies
    await saveCookies(page);

    return {
      files,
      // ideScreenshot
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
