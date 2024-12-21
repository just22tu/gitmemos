import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import crypto from 'crypto';
import { Issue, Label } from '@/types/github';
import { recordSync } from '@/lib/api';

// GitHub webhook payload类型定义
interface GitHubWebhookPayload {
  repository: {
    owner: {
      login: string;
    };
    name: string;
  };
  issue?: Issue;
  label?: Label;
}

// 验证GitHub webhook签名
function verifyGitHubWebhook(payload: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing GITHUB_WEBHOOK_SECRET');
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  const calculatedSignature = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(calculatedSignature)
  );
}

export async function POST(request: Request) {
  try {
    const headersList = await headers();
    const signature = headersList.get('x-hub-signature-256');
    const event = headersList.get('x-github-event');
    
    if (!signature) {
      return NextResponse.json(
        { error: 'Missing signature' },
        { status: 400 }
      );
    }

    const payload = await request.text();
    
    // 验证webhook签名
    if (!verifyGitHubWebhook(payload, signature)) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const data = JSON.parse(payload) as GitHubWebhookPayload;
    const { repository } = data;
    const owner = repository.owner.login;
    const repo = repository.name;

    // 处理不同类型的事件
    try {
      switch (event) {
        case 'issues':
          if (!data.issue) {
            throw new Error('Missing issue data');
          }

          // 直接使用 supabaseServer 保存 issue
          const now = new Date().toISOString();
          const { data: existingIssue } = await supabaseServer
            .from('issues')
            .select('id, created_at')
            .eq('owner', owner)
            .eq('repo', repo)
            .eq('issue_number', data.issue.number)
            .single();

          const { error: issueError } = await supabaseServer
            .from('issues')
            .upsert({
              owner,
              repo,
              issue_number: data.issue.number,
              title: data.issue.title,
              body: data.issue.body,
              state: data.issue.state,
              labels: data.issue.labels.map((label: Label) => label.name),
              github_created_at: data.issue.created_at,
              ...(existingIssue ? { created_at: existingIssue.created_at } : { created_at: now }),
              updated_at: now
            }, {
              onConflict: 'owner,repo,issue_number'
            });

          if (issueError) {
            throw issueError;
          }

          await recordSync(owner, repo, 'success', 1, undefined, 'webhook');
          break;
        
        case 'label':
          // 当label变化时，我们需要更新label数据和相关的issue
          if (data.label) {
            // 直接使用 supabaseServer 保存 label
            const now = new Date().toISOString();
            const { data: existingLabel } = await supabaseServer
              .from('labels')
              .select('*')
              .eq('owner', owner)
              .eq('repo', repo)
              .eq('name', data.label.name)
              .single();

            const { error: labelError } = await supabaseServer
              .from('labels')
              .upsert({
                owner,
                repo,
                name: data.label.name,
                color: data.label.color,
                description: data.label.description,
                ...(existingLabel ? { created_at: existingLabel.created_at } : { created_at: now }),
                updated_at: now
              }, {
                onConflict: 'owner,repo,name'
              });

            if (labelError) {
              throw labelError;
            }

            // 更新包含该label的issue的更新时间
            const { data: affectedIssues, error: fetchError } = await supabaseServer
              .from('issues')
              .select('*')
              .eq('owner', owner)
              .eq('repo', repo)
              .contains('labels', [data.label.name]);

            if (fetchError) {
              console.error('Error fetching affected issues:', fetchError);
              throw fetchError;
            }

            // 更新每个受影响的issue
            if (affectedIssues) {
              for (const issue of affectedIssues) {
                const { error: updateError } = await supabaseServer
                  .from('issues')
                  .update({
                    updated_at: new Date().toISOString()
                  })
                  .eq('owner', owner)
                  .eq('repo', repo)
                  .eq('issue_number', issue.issue_number);

                if (updateError) {
                  console.error('Error updating issue:', updateError);
                  throw updateError;
                }
              }
            }
          }
          await recordSync(owner, repo, 'success', 1, undefined, 'webhook');
          break;

        default:
          return NextResponse.json(
            { error: 'Unsupported event type' },
            { status: 400 }
          );
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      await recordSync(owner, repo, 'failed', 0, errorMessage, 'webhook');
      throw error;
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
} 