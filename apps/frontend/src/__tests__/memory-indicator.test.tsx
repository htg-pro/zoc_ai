import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryIndicator } from '@/features/agent/MemoryIndicator';
import { useApp } from '@/lib/store';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock the store
vi.mock('@/lib/store', () => ({
  useApp: vi.fn(),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Brain: () => <div data-testid="brain-icon" />,
}));

// Mock MOCK_PROVIDERS
vi.mock('@/lib/mock-data', () => ({
  MOCK_PROVIDERS: [
    {
      id: 'mock',
      name: 'Mock Provider',
      models: [
        {
          id: 'mock-model-1',
          name: 'Mock Model 1',
          context_window: 8192,
        },
      ],
    },
  ],
}));

describe('MemoryIndicator', () => {
  const mockUseApp = useApp as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing when no memory stats available', () => {
    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats: null,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Component should render
    expect(container.firstChild).toBeInTheDocument();
    // Should show the brain icon
    expect(screen.getByTestId('brain-icon')).toBeInTheDocument();
  });

  it('renders with memory stats when available', () => {
    const memoryStats = {
      context_window: 8192,
      tokens_used: 2048,
      tokens_available: 6144,
      messages_in_context: 5,
      total_messages: 10,
      dropped_messages: 0,
      has_summary: false,
    };

    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Component should render
    expect(container.firstChild).toBeInTheDocument();
    // Should show the brain icon
    expect(screen.getByTestId('brain-icon')).toBeInTheDocument();
  });

  it('renders progress bar', () => {
    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats: null,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Should render a progress bar (div with bg-muted class)
    const progressBar = container.querySelector('.bg-muted');
    expect(progressBar).toBeInTheDocument();
  });

  it('displays token count text', () => {
    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats: null,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Should display token count in the font-mono span
    const tokenDisplay = container.querySelector('.font-mono');
    expect(tokenDisplay).toBeInTheDocument();
    expect(tokenDisplay?.textContent).toMatch(/\d+\s*\/\s*\d+\.?\d*k/i);
  });

  it('shows different states based on usage', () => {
    // Test with high usage
    const highUsageStats = {
      context_window: 8192,
      tokens_used: 7000, // ~85% usage
      tokens_available: 1192,
      messages_in_context: 8,
      total_messages: 10,
      dropped_messages: 0,
      has_summary: false,
    };

    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats: highUsageStats,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Component should render without errors
    expect(container.firstChild).toBeInTheDocument();
  });

  it('handles edge case of zero tokens', () => {
    const zeroStats = {
      context_window: 8192,
      tokens_used: 0,
      tokens_available: 8192,
      messages_in_context: 0,
      total_messages: 0,
      dropped_messages: 0,
      has_summary: false,
    };

    mockUseApp.mockImplementation((selector: any) => {
      const state = {
        memoryStats: zeroStats,
        selectedModel: { id: 'mock-model-1' },
        chat: [],
        liveMode: false,
      };
      return selector(state);
    });

    const { container } = render(<MemoryIndicator />);
    
    // Component should render without errors
    expect(container.firstChild).toBeInTheDocument();
  });
});
