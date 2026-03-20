import React, { useState, useEffect, useRef } from 'react';
import { Download, Link as LinkIcon, FileText, CheckCircle, AlertCircle, Loader2, Trash2, ExternalLink, Pause, Play, Settings, ArrowUp, ArrowDown, Gauge, Image, Video, Music, Archive, File } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface DownloadTask {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
  totalSize: number | null;
  downloadedBytes: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error';
  priority: 'low' | 'medium' | 'high';
  speedLimit: number; // bytes per second, 0 for unlimited
  timestamp: number;
  error?: string;
  acceptRanges: boolean;
  fileHandle?: FileSystemFileHandle; // For "Save As" functionality
}

export default function App() {
  const [url, setUrl] = useState('');
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [globalSpeedLimit, setGlobalSpeedLimit] = useState(0);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const activeDownloads = useRef<{ [key: string]: AbortController }>({});

  // Load state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('download_tasks');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Reset downloading status to paused on load, and remove non-serializable fileHandles
        setTasks(parsed.map((t: DownloadTask) => ({
          ...t,
          status: t.status === 'downloading' ? 'paused' : t.status,
          fileHandle: undefined 
        })));
      } catch (e) {
        console.error('Failed to parse tasks');
      }
    }
  }, []);

  // Save state to localStorage (excluding fileHandle)
  useEffect(() => {
    const tasksToSave = tasks.map(({ fileHandle, ...rest }) => rest);
    localStorage.setItem('download_tasks', JSON.stringify(tasksToSave));
  }, [tasks]);

  const formatSize = (bytes: number | null) => {
    if (bytes === null || bytes === undefined) return '未知大小';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec === 0) return '无限制';
    return `${formatSize(bytesPerSec)}/s`;
  };

  const getFileIcon = (contentType: string | undefined, filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    
    if (contentType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext || '')) {
      return <Image className="w-6 h-6" />;
    }
    if (contentType?.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv'].includes(ext || '')) {
      return <Video className="w-6 h-6" />;
    }
    if (contentType?.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext || '')) {
      return <Music className="w-6 h-6" />;
    }
    if (contentType?.includes('zip') || contentType?.includes('archive') || contentType?.includes('compressed') || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext || '')) {
      return <Archive className="w-6 h-6" />;
    }
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext || '')) {
      return <FileText className="w-6 h-6" />;
    }
    return <File className="w-6 h-6" />;
  };

  const addTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setIsFetching(true);
    setError(null);

    try {
      const metaRes = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
      if (!metaRes.ok) throw new Error('无法获取文件信息，请检查链接是否有效。');
      
      const metadata = await metaRes.json();
      
      let fileHandle: FileSystemFileHandle | undefined;
      
      // Try to use File System Access API for "Save As"
      if ('showSaveFilePicker' in window) {
        try {
          fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: metadata.filename || 'download',
          });
        } catch (err) {
          // User cancelled or error, fallback to default if they didn't cancel
          console.log('Save picker cancelled or failed', err);
        }
      }

      const newTask: DownloadTask = {
        id: Math.random().toString(36).substr(2, 9),
        url: url,
        filename: fileHandle?.name || metadata.filename || 'download',
        contentType: metadata.contentType,
        totalSize: metadata.contentLength,
        downloadedBytes: 0,
        status: 'pending',
        priority: 'medium',
        speedLimit: 0,
        timestamp: Date.now(),
        acceptRanges: metadata.acceptRanges || false,
        fileHandle,
      };

      setTasks(prev => [newTask, ...prev]);
      setUrl('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsFetching(false);
    }
  };

  const startDownload = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === 'downloading') return;

    const controller = new AbortController();
    activeDownloads.current[taskId] = controller;

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'downloading' } : t));

    try {
      const downloadUrl = `/api/download?url=${encodeURIComponent(task.url)}&filename=${encodeURIComponent(task.filename)}&start=${task.downloadedBytes}&speedLimit=${task.speedLimit || globalSpeedLimit}`;
      
      const response = await fetch(downloadUrl, { signal: controller.signal });
      if (!response.ok) throw new Error('下载失败');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取数据流');

      let writable: any;
      if (task.fileHandle) {
        // If we have a file handle, we can write directly to the chosen path
        writable = await (task.fileHandle as any).createWritable({ keepExistingData: true });
        if (task.downloadedBytes > 0) {
          await writable.seek(task.downloadedBytes);
        }
      }

      let receivedBytes = task.downloadedBytes;
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        receivedBytes += value.length;
        if (writable) {
          await writable.write(value);
        } else {
          chunks.push(value);
        }

        // Update progress periodically
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, downloadedBytes: receivedBytes } : t));
      }

      if (writable) {
        await writable.close();
      } else {
        // Fallback: Combine chunks and save via browser default
        const blob = new Blob(chunks);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = task.filename;
        a.click();
        window.URL.revokeObjectURL(url);
      }

      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'completed' } : t));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'paused' } : t));
      } else {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'error', error: err.message } : t));
      }
    } finally {
      delete activeDownloads.current[taskId];
    }
  };

  const pauseDownload = (taskId: string) => {
    if (activeDownloads.current[taskId]) {
      activeDownloads.current[taskId].abort();
    }
  };

  const removeTask = (id: string) => {
    pauseDownload(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const updateTaskPriority = (id: string, priority: 'low' | 'medium' | 'high') => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, priority } : t));
  };

  const updateTaskSpeedLimit = (id: string, limit: number) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, speedLimit: limit } : t));
  };

  const getPriorityLabel = (priority: string) => {
    switch(priority) {
      case 'low': return '低';
      case 'medium': return '中';
      case 'high': return '高';
      default: return priority;
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-[#212529] font-sans selection:bg-blue-100">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <header className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Download className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">SwiftFetch 下载器 Pro</h1>
              <p className="text-sm text-neutral-500">先进的多协议下载管理器</p>
            </div>
          </div>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className={`p-3 rounded-xl transition-all ${showSettings ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'}`}
          >
            <Settings className="w-6 h-6" />
          </button>
        </header>

        {/* Global Settings */}
        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-white rounded-3xl shadow-sm border border-neutral-200 p-6 mb-8"
            >
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Gauge className="w-5 h-5 text-blue-600" />
                全局设置
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-neutral-500 mb-2">全局限速 (KB/s)</label>
                  <div className="flex items-center gap-3">
                    <input 
                      type="number" 
                      min="0"
                      value={globalSpeedLimit / 1024 || ''}
                      onChange={(e) => setGlobalSpeedLimit(parseInt(e.target.value) * 1024 || 0)}
                      placeholder="无限制"
                      className="flex-1 px-4 py-2 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 outline-none"
                    />
                    <span className="text-sm text-neutral-400">0 = 无限制</span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Add Task */}
        <div className="bg-white rounded-3xl shadow-sm border border-neutral-200 p-6 mb-10">
          <form onSubmit={addTask} className="flex gap-3">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <LinkIcon className="w-5 h-5 text-neutral-400" />
              </div>
              <input
                type="text"
                required
                placeholder="输入 HTTP, HTTPS 或 FTP 链接..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-neutral-50 border border-neutral-200 rounded-2xl focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
              />
            </div>
            <button
              type="submit"
              disabled={isFetching}
              className="px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-300 text-white font-semibold rounded-2xl shadow-lg shadow-blue-600/20 transition-all flex items-center gap-2"
            >
              {isFetching ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
              添加任务
            </button>
          </form>
          {error && <p className="mt-3 text-sm text-red-500 flex items-center gap-1"><AlertCircle className="w-4 h-4" /> {error}</p>}
          <p className="mt-4 text-xs text-neutral-400">提示：添加任务时会弹出文件选择框，您可以自由选择保存路径。</p>
        </div>

        {/* Task Queue */}
        <div className="space-y-4">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xl font-bold">下载队列</h2>
            <div className="flex items-center gap-4 text-sm text-neutral-400">
              <span>{tasks.filter(t => t.status === 'downloading').length} 正在下载</span>
              <span>•</span>
              <span>{tasks.length} 总任务</span>
            </div>
          </div>

          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {tasks.length === 0 ? (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center py-20 bg-white rounded-3xl border border-dashed border-neutral-300"
                >
                  <Download className="w-12 h-12 text-neutral-200 mx-auto mb-4" />
                  <p className="text-neutral-400">队列为空。添加链接开始下载。</p>
                </motion.div>
              ) : (
                tasks.map((task) => (
                  <motion.div
                    key={task.id}
                    layout
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    className="bg-white p-4 md:p-5 rounded-3xl shadow-sm border border-neutral-200 group"
                  >
                    {/* Top Row: Icon, Info, Actions */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          task.status === 'completed' ? 'bg-green-50 text-green-600' : 
                          task.status === 'error' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'
                        }`}>
                          {getFileIcon(task.contentType, task.filename)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <h3 className="font-bold truncate text-base" title={task.filename}>{task.filename}</h3>
                            {(task.contentType?.startsWith('image/') || task.contentType?.startsWith('video/')) && (
                              <a 
                                href={task.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="p-1 text-neutral-400 hover:text-blue-600 transition-colors"
                                title="预览"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>
                          <p className="text-[10px] text-neutral-400 truncate max-w-[200px] md:max-w-md">{task.url}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-1">
                        <select 
                          value={task.priority}
                          onChange={(e) => updateTaskPriority(task.id, e.target.value as any)}
                          className="text-[10px] font-medium bg-neutral-50 border border-neutral-100 rounded-lg px-2 py-1 outline-none cursor-pointer hover:bg-neutral-100 transition-colors"
                        >
                          <option value="low">低</option>
                          <option value="medium">中</option>
                          <option value="high">高</option>
                        </select>
                        <button 
                          onClick={() => removeTask(task.id)}
                          className="p-1.5 text-neutral-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar (Thinner) */}
                    <div className="relative h-1.5 bg-neutral-100 rounded-full overflow-hidden mb-3">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${task.totalSize ? (task.downloadedBytes / task.totalSize) * 100 : 0}%` }}
                        className={`absolute inset-y-0 left-0 transition-all ${task.status === 'error' ? 'bg-red-500' : 'bg-blue-600'}`}
                      />
                    </div>

                    {/* Bottom Row: Stats & Controls */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-4 text-[11px] text-neutral-500">
                        <div className="flex items-center gap-1 font-medium">
                          <span className="text-neutral-900">{formatSize(task.downloadedBytes)}</span>
                          <span className="text-neutral-300">/</span>
                          <span>{formatSize(task.totalSize)}</span>
                        </div>
                        
                        {task.status === 'downloading' && (
                          <div className="flex items-center gap-1 text-blue-600 font-semibold bg-blue-50 px-2 py-0.5 rounded-full">
                            <ArrowDown className="w-3 h-3 animate-bounce" />
                            <span>{formatSpeed(task.speedLimit || globalSpeedLimit)}</span>
                          </div>
                        )}

                        <span className="font-bold text-neutral-900 bg-neutral-100 px-2 py-0.5 rounded-full">
                          {task.totalSize ? Math.round((task.downloadedBytes / task.totalSize) * 100) : 0}%
                        </span>
                      </div>

                      <div className="flex items-center gap-2 ml-auto">
                        {/* Speed Limit Input (Compact) */}
                        <div className="hidden sm:flex items-center gap-1.5 bg-neutral-50 border border-neutral-100 rounded-lg px-2 py-1">
                          <Gauge className="w-3 h-3 text-neutral-400" />
                          <input 
                            type="number" 
                            placeholder="限速"
                            className="w-12 bg-transparent text-[10px] outline-none"
                            value={task.speedLimit / 1024 || ''}
                            onChange={(e) => updateTaskSpeedLimit(task.id, parseInt(e.target.value) * 1024 || 0)}
                          />
                        </div>

                        {/* Action Button */}
                        {task.status === 'downloading' ? (
                          <button 
                            onClick={() => pauseDownload(task.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-xl text-xs font-semibold transition-all"
                          >
                            <Pause className="w-3.5 h-3.5" /> 暂停
                          </button>
                        ) : task.status === 'completed' ? (
                          <div className="flex items-center gap-1.5 text-green-600 font-semibold text-xs px-3 py-1.5 bg-green-50 rounded-xl">
                            <CheckCircle className="w-3.5 h-3.5" /> 完成
                          </div>
                        ) : (
                          <button 
                            onClick={() => startDownload(task.id)}
                            disabled={task.status === 'completed'}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold transition-all shadow-sm shadow-blue-600/10"
                          >
                            <Play className="w-3.5 h-3.5" /> {task.downloadedBytes > 0 ? '继续' : '开始'}
                          </button>
                        )}
                      </div>
                    </div>

                    {task.error && (
                      <div className="mt-3 p-2 bg-red-50 text-red-600 text-[10px] rounded-xl flex items-center gap-2">
                        <AlertCircle className="w-3 h-3" />
                        {task.error}
                      </div>
                    )}
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
