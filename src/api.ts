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

// async function captureScreenshot(page: any, name: string) {
//   const screenshot = await page.screenshot({
//     type: 'png',
//     fullPage: true
//   });
//   const base64Image = screenshot.toString('base64');
//   return base64Image;
// }

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

    // Wait 5 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('Generation timed out');
}

async function extractCode(page: any) {
  let attempts = 0;
  const maxAttempts = 5;
  
  while (attempts < maxAttempts) {
    try {
      // First click the Code tab in the top navigation
      await page.act({ 
        action: "click the Code tab" 
      });
      
      // Wait for code tab to be active
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get all available actions
      const actions = await page.observe() as ObserveAction[];
      
      // Get the current filename from the active tab
      const fileTab = actions.find(action => 
        action.description.toLowerCase().includes('tab') && 
        action.description.toLowerCase().includes('.') &&
        !action.description.toLowerCase().includes('click')
      );
      
      const filename = fileTab ? fileTab.description.trim() : 'code.tsx';

      // Click the copy button
      await page.act({
        action: "click the copy button"
      });

      // Get clipboard content
      const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());

      // Verify we got some code
      if (clipboardContent && clipboardContent.trim().length > 0) {
        return {
          [filename]: clipboardContent
        };
      }
    } catch (error) {
      console.log('Copy attempt failed:', error);
    }

    // If no code found or copy failed, wait and try again
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempts++;
  }

  throw new Error('Failed to copy code after multiple attempts');
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

    // Press Enter instead of clicking button
    await page.keyboard.press('Enter');

    // Wait for generation to complete using observe
    await waitForGeneration(page);

    // Extract code
    const files = await extractCode(page);

    // Save the latest cookies
    await saveCookies(page);

    return {
      files
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
