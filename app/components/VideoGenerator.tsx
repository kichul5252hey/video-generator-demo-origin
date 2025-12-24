'use client';

import { useState, useEffect, useRef } from 'react';
import { fal } from '@fal-ai/client';

// Configure fal client to use the proxy
fal.config({
  proxyUrl: '/api/fal/proxy',
});

// Model configurations
const MODELS = {
  veo2: {
    id: 'fal-ai/veo2/image-to-video',
    name: 'Veo 2 (Google)',
    description: 'Google의 Veo 2 모델 - 빠른 생성',
  },
  'wan2.6': {
    id: 'wan/v2.6/image-to-video',
    name: 'WAN 2.6',
    description: '720p/1080p, 5-15초, 멀티샷 지원',
  },
} as const;

type ModelKey = keyof typeof MODELS;

const QUEUE_POLL_INTERVAL_MS = 8000;
const PROGRESS_POLL_INTERVAL_MS = 5000;

type QueueStatus = {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  logs?: Array<{ message: string }>;
  request_id: string;
};

type VideoResponse = {
  data: {
    video: {
      url: string;
    };
  };
};


export default function VideoGenerator() {
  const [image, setImage] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const pollingTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<ModelKey>('veo2');

  // WAN 2.6 specific options
  const [resolution, setResolution] = useState<'720p' | '1080p'>('1080p');
  const [duration, setDuration] = useState<'5' | '10' | '15'>('5');
  const [enablePromptExpansion, setEnablePromptExpansion] = useState(true);
  const [multiShots, setMultiShots] = useState(false);
  const [negativePrompt, setNegativePrompt] = useState('');

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, []);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      setError(null);
    }
  };

  const getModelId = (model: ModelKey) => MODELS[model].id;

  const fetchResult = async (
    id: string,
    model: ModelKey
  ): Promise<VideoResponse> => {
    return fal.queue.result(getModelId(model), {
      requestId: id,
    });
  };

  const fetchStatus = async (
    id: string,
    model: ModelKey
  ): Promise<QueueStatus> => {
    return fal.queue.status(getModelId(model), {
      requestId: id,
      logs: true,
    }) as QueueStatus;
  };

  const checkStatus = async (id: string, model: ModelKey) => {
    try {
      console.log('Checking status for request:', id);
      const status = await fetchStatus(id, model);

      console.log('Received status:', status);

      if (status.status === 'COMPLETED') {
        console.log('Generation completed, fetching result...');
        try {
          const response = await fetchResult(id, model);
          console.log('Received result:', response);

          if (response.data?.video?.url) {
            setVideoUrl(response.data.video.url);
            setIsGenerating(false);
            setProgress('Video generation completed!');
          } else {
            console.error('No video URL in result:', response);
            setError('Video generation completed but no video URL was returned');
            setIsGenerating(false);
            setProgress('');
          }
        } catch (err) {
          console.error('Error fetching result:', err);
          setError('Failed to fetch video data');
          setIsGenerating(false);
          setProgress('');
        }
      } else if (status.status === 'FAILED') {
        console.error('Generation failed:', status);
        setError('Video generation failed');
        setIsGenerating(false);
        setProgress('');
      } else if (status.status === 'IN_PROGRESS' || status.status === 'IN_QUEUE') {
        const lastLog = status.logs?.[status.logs.length - 1]?.message;
        console.log('Still processing, last log:', lastLog);
        setProgress(
          lastLog ||
            (status.status === 'IN_QUEUE' ? 'Queued for processing...' : 'Processing...')
        );
        const nextDelay =
          status.status === 'IN_QUEUE'
            ? QUEUE_POLL_INTERVAL_MS
            : PROGRESS_POLL_INTERVAL_MS;
        pollingTimeoutRef.current = setTimeout(
          () => checkStatus(id, model),
          nextDelay
        );
      } else {
        console.error('Unknown status:', status.status);
        setError('Received unknown status from server');
        setIsGenerating(false);
        setProgress('');
      }
    } catch (err) {
      console.error('Error checking status:', err);
      setError(err instanceof Error ? err.message : 'Failed to check status');
      setIsGenerating(false);
      setProgress('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image || !prompt) {
      setError('Please provide both an image and a prompt');
      return;
    }

    // Clear any existing polling
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
    }

    setIsGenerating(true);
    setError(null);
    setProgress('Uploading image...');

    try {
      const modelKey = selectedModel;
      const imageUrl = await fal.storage.upload(image);
      setProgress('Starting video generation...');

      let input: Record<string, unknown>;

      if (modelKey === 'wan2.6') {
        input = {
          prompt,
          image_url: imageUrl,
          resolution,
          duration,
          enable_prompt_expansion: enablePromptExpansion,
          multi_shots: multiShots,
          ...(negativePrompt.trim().length > 0 && {
            negative_prompt: negativePrompt,
          }),
        };
      } else {
        input = {
          prompt,
          image_url: imageUrl,
          aspect_ratio: '16:9',
          duration: '5s',
        };
      }

      const { request_id } = await fal.queue.submit(getModelId(modelKey), {
        input,
      });

      console.log('Submitted request with ID:', request_id);
      // Start checking status
      checkStatus(request_id, modelKey);
    } catch (err) {
      console.error('Error submitting request:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate video');
      setIsGenerating(false);
      setProgress('');
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Model Selection */}
        <div>
          <label className="block text-sm font-medium mb-2">
            Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as ModelKey)}
            className="w-full p-2 border rounded-md bg-white dark:bg-black"
            disabled={isGenerating}
          >
            {Object.entries(MODELS).map(([key, model]) => (
              <option key={key} value={key}>
                {model.name} - {model.description}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            Upload Image
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            className="w-full p-2 border rounded-md"
            disabled={isGenerating}
          />
          {image && (
            <p className="mt-2 text-sm text-gray-600">
              Selected: {image.name}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            Animation Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe how you want the image to be animated..."
            className="w-full p-2 border rounded-md h-32"
            disabled={isGenerating}
          />
        </div>

        {/* WAN 2.6 Specific Options */}
        {selectedModel === 'wan2.6' && (
          <div className="space-y-4 p-4 bg-gray-50 dark:bg-black rounded-md">
            <h3 className="font-medium text-sm text-gray-700">WAN 2.6 Options</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Resolution</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as '720p' | '1080p')}
                  className="w-full p-2 border rounded-md bg-white dark:bg-black"
                  disabled={isGenerating}
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Duration</label>
                <select
                  value={duration}
                  onChange={(e) => setDuration(e.target.value as '5' | '10' | '15')}
                  className="w-full p-2 border rounded-md bg-white dark:bg-black"
                  disabled={isGenerating}
                >
                  <option value="5">5 seconds</option>
                  <option value="10">10 seconds</option>
                  <option value="15">15 seconds</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Negative Prompt (optional)</label>
              <input
                type="text"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="e.g., low quality, blurry, distorted"
                className="w-full p-2 border rounded-md"
                disabled={isGenerating}
              />
            </div>

            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enablePromptExpansion}
                  onChange={(e) => setEnablePromptExpansion(e.target.checked)}
                  disabled={isGenerating}
                  className="rounded"
                />
                Prompt Expansion (LLM 활용)
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={multiShots}
                  onChange={(e) => setMultiShots(e.target.checked)}
                  disabled={isGenerating || !enablePromptExpansion}
                  className="rounded"
                />
                Multi-shot
              </label>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={isGenerating || !image || !prompt}
          className={`w-full py-2 px-4 rounded-md text-white font-medium
            ${isGenerating || !image || !prompt
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
        >
          {isGenerating ? 'Generating Video...' : 'Generate Video'}
        </button>
      </form>

      {error && (
        <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-md">
          {error}
        </div>
      )}

      {progress && (
        <div className="mt-4 p-4 bg-blue-50 text-blue-700 rounded-md">
          {progress}
        </div>
      )}

      {videoUrl && (
        <div className="mt-6">
          <h3 className="text-lg font-medium mb-2">Generated Video</h3>
          <video
            controls
            className="w-full rounded-lg"
            src={videoUrl}
          >
            Your browser does not support the video tag.
          </video>
        </div>
      )}
    </div>
  );
} 
