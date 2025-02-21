'use client';

import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { Issue, GitHubConfig } from '@/types/github';
import { getIssues as getGitHubIssues, getGitHubConfig, getToken } from '@/lib/github';
import { checkSyncStatus, recordSync, saveLabel, saveIssues } from '@/lib/supabase-client';
import { cacheManager, CACHE_KEYS, CACHE_EXPIRY } from '@/lib/cache';
import { getIssues as getIssuesFromApi } from '@/lib/supabase-client';
import { Octokit } from 'octokit';

interface IssueContextType {
  issues: Issue[];
  config: GitHubConfig | null;
  loading: boolean;
  initialized: boolean;
  isInitializing: boolean;
  syncIssues: () => Promise<{ success: boolean; totalSynced: number; syncType: 'full' | 'add' }>;
  updateIssues: (newIssues: Issue[]) => void;
  refreshIssues: () => Promise<void>;
}

const IssueContext = createContext<IssueContextType>({
  issues: [],
  config: null,
  loading: true,
  initialized: false,
  isInitializing: false,
  syncIssues: async () => ({ success: false, totalSynced: 0, syncType: 'add' }),
  updateIssues: () => {},
  refreshIssues: async () => {}
});

export function IssueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IssueContextType>({
    issues: [],
    config: null,
    loading: true,
    initialized: false,
    isInitializing: false,
    syncIssues: async () => ({ success: false, totalSynced: 0, syncType: 'add' }),
    updateIssues: () => {},
    refreshIssues: async () => {}
  });

  const initializingRef = useRef(false);
  const initializePromiseRef = useRef<Promise<void>>();
  const configRef = useRef<GitHubConfig | null>(null);
  const lastSyncTimeRef = useRef<number>(0);

  // Memoize these functions to prevent unnecessary re-renders
  const syncIssues = useCallback(async () => {
    if (!configRef.current) {
      throw new Error('GitHub configuration is missing. Please configure your settings first.');
    }

    // Check if last sync was less than 1 minute ago
    const now = Date.now();
    const timeSinceLastSync = now - lastSyncTimeRef.current;
    if (timeSinceLastSync < 60000) { // 60000ms = 1 minute
      throw new Error(`Please wait ${Math.ceil((60000 - timeSinceLastSync) / 1000)} seconds before syncing again.`);
    }

    setState(prev => ({ ...prev, loading: true }));
    try {
      // Update last sync time
      lastSyncTimeRef.current = now;

      // Get GitHub token and initialize Octokit
      const token = await getToken();
      if (!token) {
        throw new Error('GitHub token not found');
      }
      const octokit = new Octokit({ auth: token });
      const config = configRef.current;

      // 首先同步标签
      console.log('Syncing labels from GitHub...');
      const labelsResponse = await octokit.rest.issues.listLabelsForRepo({
        owner: config.owner,
        repo: config.repo,
      });

      const labels = labelsResponse.data.map(label => ({
        id: label.id,
        name: label.name,
        color: label.color,
        description: label.description,
      }));

      // 保存标签到数据库
      let savedLabels = 0;
      let failedLabels = 0;
      for (const label of labels) {
        try {
          const success = await saveLabel(config.owner, config.repo, label);
          if (success) {
            savedLabels++;
          } else {
            failedLabels++;
          }
        } catch {
          failedLabels++;
        }
      }

      if (failedLabels > 0) {
        console.log(`Synced ${labels.length} labels: ${savedLabels} succeeded, ${failedLabels} failed`);
      } else {
        console.log(`Successfully synced ${labels.length} labels`);
      }

      // 获取上次同步状态
      const syncStatus = await checkSyncStatus(config.owner, config.repo);
      const isFullSync = !syncStatus?.lastSyncAt;

      // 同步 issues
      console.log(isFullSync ? 'Performing full sync...' : `Performing incremental sync since ${syncStatus.lastSyncAt}`);
      
      const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
        owner: config.owner,
        repo: config.repo,
        state: 'all',
        per_page: config.issuesPerPage || 50,
        page: 1,
        sort: 'updated',
        direction: 'desc'
      };

      if (!isFullSync && syncStatus?.lastSyncAt) {
        params.since = syncStatus.lastSyncAt;
      }

      const { data } = await octokit.rest.issues.listForRepo(params);

      const issues = data.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        created_at: issue.created_at,
        github_created_at: issue.created_at,
        state: issue.state,
        labels: issue.labels
          .filter((label): label is { id: number; name: string; color: string; description: string | null } => 
            typeof label === 'object' && label !== null)
          .map(label => ({
            id: label.id,
            name: label.name,
            color: label.color,
            description: label.description,
          }))
      }));

      // 增量同步时，如果没有更新的内容，直接返回
      if (!isFullSync && issues.length === 0) {
        console.log('No updates found since last sync');
        await recordSync(
          config.owner,
          config.repo,
          'success',
          0,
          undefined,
          'add'
        );
        return {
          success: true,
          totalSynced: 0,
          syncType: 'add' as const
        };
      }

      // 批量保存 issues 到数据库
      const saveResult = await saveIssues(config.owner, config.repo, issues);
      if (!saveResult) {
        throw new Error('Failed to save issues to database');
      }

      // Update state and cache
      setState(prev => {
        if (!prev.config) return prev;

        // 如果是增量同步，合并现有issues和新issues
        let updatedIssues = issues;
        if (!isFullSync && prev.issues) {
          const existingIssues = new Map(prev.issues.map(issue => [issue.number, issue]));
          issues.forEach(issue => existingIssues.set(issue.number, issue));
          updatedIssues = Array.from(existingIssues.values());
        }

        // 清理所有相关缓存
        console.log('Clearing all related caches after sync...');
        const currentConfig = configRef.current;
        if (currentConfig) {
          const stats = cacheManager?.getStats();
          if (stats) {
            stats.keys.forEach(key => {
              if (key.includes(`${currentConfig.owner}:${currentConfig.repo}`)) {
                cacheManager?.remove(key);
                console.log(`Cleared cache: ${key}`);
              }
            });
          }
        }

        // 设置新的缓存
        const newState = {
          issues: updatedIssues,
          config: prev.config,
        };
        
        cacheManager?.set(
          CACHE_KEYS.ISSUES(prev.config.owner, prev.config.repo, 1, ''),
          newState,
          { expiry: CACHE_EXPIRY.ISSUES }
        );
        console.log('New cache set successfully');

        return { 
          ...prev,
          issues: updatedIssues,
          loading: false 
        };
      });

      // Record successful sync
      const currentConfig = configRef.current;
      if (!currentConfig) {
        throw new Error('GitHub configuration is missing');
      }
      await recordSync(
        currentConfig.owner,
        currentConfig.repo,
        'success',
        issues.length,
        undefined,
        isFullSync ? 'full' : 'add'
      );

      console.log(`Synced ${issues.length} issues from GitHub to database`);
      
      return {
        success: true,
        totalSynced: issues.length,
        syncType: isFullSync ? 'full' as const : 'add' as const
      };
    } catch (error) {
      console.error('Error syncing from GitHub:', error);
      
      // Record sync failure
      if (configRef.current) {
        await recordSync(
          configRef.current.owner,
          configRef.current.repo,
          'failed',
          0,
          error instanceof Error ? error.message : 'Unknown error',
          'full'
        );
      }
      
      setState(prev => ({ ...prev, loading: false }));
      
      // Re-throw with more descriptive error
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Failed to sync with GitHub');
      }
    }
  }, []);

  const updateIssues = useCallback((newIssues: Issue[]) => {
    if (!configRef.current) return;
    const config = configRef.current;
    
    setState(prev => ({ ...prev, issues: newIssues }));
    cacheManager?.set(
      CACHE_KEYS.ISSUES(config.owner, config.repo, 1, ''),
      { issues: newIssues },
      { expiry: CACHE_EXPIRY.ISSUES }
    );
  }, []);

  const fetchIssues = useCallback(async () => {
    if (!configRef.current) return;
    const config = configRef.current;
    
    setState(prev => ({ ...prev, loading: true }));
    try {
      const result = await getIssuesFromApi(config.owner, config.repo);
      if (result?.issues) {
        setState(prev => ({ ...prev, issues: result.issues }));
        cacheManager?.set(
          CACHE_KEYS.ISSUES(config.owner, config.repo, 1, ''),
          { issues: result.issues },
          { expiry: CACHE_EXPIRY.ISSUES }
        );
      }
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  }, []);

  const refreshIssues = useCallback(async () => {
    // Clear the cache first
    if (!configRef.current) return;
    const config = configRef.current;
    
    cacheManager?.remove(CACHE_KEYS.ISSUES(config.owner, config.repo, 1, ''));
    // Then fetch fresh data
    await fetchIssues();
  }, [fetchIssues]);

  useEffect(() => {
    let mounted = true;
    
    async function initializeData() {
      if (state.initialized || initializingRef.current) return;
      initializingRef.current = true;

      try {
        // 获取配置
        const config = await getGitHubConfig();
        configRef.current = config;
        
        if (!config || !config.owner || !config.repo) {
          if (mounted) {
            setState(prev => ({ 
              ...prev, 
              loading: false, 
              initialized: true,
              syncIssues,
              updateIssues,
              refreshIssues
            }));
          }
          return;
        }

        // 检查步状态
        const syncStatus = await checkSyncStatus(config.owner, config.repo);
        if (syncStatus?.lastSyncAt) {
          console.log(
            `Last sync time: ${new Date(syncStatus.lastSyncAt).toLocaleString()}`
          );
        }

        // 从服务器获取数据
        const issuesResult = await getGitHubIssues(config.owner, config.repo);
        
        if (mounted) {
          // 确保 issues 数组存在
          const issues = issuesResult || [];
          console.log('Loaded issues:', { count: issues.length });

          setState(prev => ({
            ...prev,
            issues,
            config,
            loading: false,
            initialized: true,
            syncIssues,
            updateIssues,
            refreshIssues
          }));

          // 更新缓存
          if (issues.length > 0) {
            console.log('Updating cache with issues');
            cacheManager?.set(
              CACHE_KEYS.ISSUES(config.owner, config.repo, 1, ''),
              { issues },
              { expiry: CACHE_EXPIRY.ISSUES }
            );
          }
        }
      } catch (error) {
        console.error('Error initializing data:', error);
        if (mounted) {
          setState(prev => ({ 
            ...prev, 
            loading: false, 
            initialized: true,
            syncIssues,
            updateIssues,
            refreshIssues
          }));
        }
      } finally {
        initializingRef.current = false;
      }
    }

    // Create or reuse the initialization promise
    if (!initializePromiseRef.current) {
      initializePromiseRef.current = initializeData();
    }

    // Wait for initialization to complete
    initializePromiseRef.current.finally(() => {
      if (!mounted) return;
      initializePromiseRef.current = undefined;
    });

    return () => {
      mounted = false;
    };
  }, [syncIssues, updateIssues, refreshIssues, state.initialized]);

  return (
    <IssueContext.Provider value={state}>
      {children}
    </IssueContext.Provider>
  );
}

export function useIssues() {
  return useContext(IssueContext);
} 