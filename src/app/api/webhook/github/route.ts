import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import crypto from 'crypto';
import { Issue, Label } from '@/types/github';
import { cacheManager, CACHE_KEYS } from '@/lib/cache';

interface GitHubWebhookIssue extends Omit<Issue, 'labels'> {
  labels: Label[];
}

// 验证 GitHub webhook 签名
function verifyGitHubWebhook(payload: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing GITHUB_WEBHOOK_SECRET');
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(payload).digest('hex');
  const calculatedSignature = `sha256=${digest}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(calculatedSignature)
  );
}

// 记录同步历史
async function recordSync(
  owner: string,
  repo: string,
  status: 'success' | 'failed',
  issuesSynced: number,
  errorMessage?: string
) {
  try {
    // 插入新记录
    const { error: insertError } = await supabaseServer
      .from('sync_history')
      .insert({
        owner,
        repo,
        status,
        issues_synced: issuesSynced,
        error_message: errorMessage,
        last_sync_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Error recording sync history:', insertError);
      return;
    }

    // 清理旧记录
    const { data: allRecords, error: selectError } = await supabaseServer
      .from('sync_history')
      .select('id, last_sync_at')
      .eq('owner', owner)
      .eq('repo', repo)
      .order('last_sync_at', { ascending: false });

    if (selectError) {
      console.error('Error fetching sync records:', selectError);
      return;
    }

    // 保留最近20条记录
    if (allRecords && allRecords.length > 20) {
      const recordsToDelete = allRecords.slice(20);
      const idsToDelete = recordsToDelete.map(record => record.id);

      const { error: deleteError } = await supabaseServer
        .from('sync_history')
        .delete()
        .in('id', idsToDelete);

      if (deleteError) {
        console.error('Error cleaning up old sync records:', deleteError);
      }
    }
  } catch (error) {
    console.error('Error in recordSync:', error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.text();
    const headersList = await headers();
    const signature = headersList.get('x-hub-signature-256');

    // 验证 webhook 签名
    if (!signature || !verifyGitHubWebhook(payload, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(payload);
    const eventType = headersList.get('x-github-event');
    const repository = event.repository;
    const owner = repository.owner.login;
    const repo = repository.name;

    try {
      if (eventType === 'issues') {
        const issue = event.issue as GitHubWebhookIssue;

        // 验证必要字段
        if (!issue.number || !issue.title || !issue.state) {
          console.error('Missing required issue fields:', issue);
          throw new Error('Missing required issue fields');
        }

        const now = new Date().toISOString();

        // 准备要保存到 Supabase 的数据
        const issueData = {
          owner: owner.trim(),
          repo: repo.trim(),
          issue_number: parseInt(issue.number.toString(), 10), // 确保是整数
          title: issue.title.trim(),
          body: issue.body?.trim() || '', // 确保 body 不为 null
          state: issue.state.trim(),
          labels: Array.isArray(issue.labels) 
            ? issue.labels.map((label: Label) => label.name.trim())
            : [],
          github_created_at: new Date(issue.created_at).toISOString(), // 确保日期格式正确
          created_at: now, // 添加 created_at 字段
          updated_at: now
        };

        console.log('Saving issue data to Supabase:', JSON.stringify(issueData, null, 2));

        // 保存到 Supabase
        const { error: issueError } = await supabaseServer
          .from('issues')
          .upsert(issueData, {
            onConflict: 'owner,repo,issue_number'
          });

        if (issueError) {
          console.error('Error saving issue to Supabase:', {
            error: issueError,
            data: issueData
          });
          throw issueError;
        }

        console.log('Successfully saved issue to Supabase:', {
          owner,
          repo,
          issue_number: issue.number
        });

        // 清除相关缓存
        const issuesListCacheKey = CACHE_KEYS.ISSUES(owner, repo, 1, '');
        const singleIssueCacheKey = `issue:${owner}:${repo}:${issue.number}`;
        cacheManager?.remove(issuesListCacheKey);
        cacheManager?.remove(singleIssueCacheKey);

        // 记录成功的同步
        await recordSync(owner, repo, 'success', 1);
      } else if (eventType === 'label') {
        const label = event.label as Label;
        const action = event.action;

        if (action === 'deleted') {
          // 删除标签
          const { error: deleteError } = await supabaseServer
            .from('labels')
            .delete()
            .match({
              owner,
              repo,
              name: label.name
            });

          if (deleteError) {
            throw deleteError;
          }
        } else {
          // 创建或更新标签
          const labelData = {
            owner,
            repo,
            name: label.name,
            color: label.color,
            description: label.description,
            updated_at: new Date().toISOString()
          };

          const { error: labelError } = await supabaseServer
            .from('labels')
            .upsert(labelData, {
              onConflict: 'owner,repo,name'
            });

          if (labelError) {
            throw labelError;
          }
        }

        // 记录成功的同步
        await recordSync(owner, repo, 'success', 0);
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      // 记录失败的同步
      await recordSync(
        owner,
        repo,
        'failed',
        0,
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    );
  }
} 