import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockOpenReport = jest.fn(async (_source: unknown) => {});
jest.mock('@/feedback/open-report', () => ({
  useOpenReport: () => ({ openReport: mockOpenReport, capturing: false }),
}));

import { CrashBoundary } from '@/feedback/CrashBoundary';

function Boom(): ReactNode {
  throw new Error('kaboom');
}

test('an unhandled render error shows the diagnostic fallback and reports the crash', async () => {
  // React logs the caught render error; that noise is expected here.
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const screen = await render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('crash-report')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('crash-report'));
    expect(mockOpenReport).toHaveBeenCalledWith({ route: '/crash', surface: 'crash' });
  } finally {
    consoleError.mockRestore();
  }
});

test('retrying clears the boundary and re-renders the children', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  let shouldThrow = true;
  function Sometimes(): ReactNode {
    if (shouldThrow) {
      throw new Error('transient');
    }
    return null;
  }
  try {
    const screen = await render(
      <CrashBoundary>
        <Sometimes />
      </CrashBoundary>,
    );
    await waitFor(() => expect(screen.getByTestId('crash-retry')).toBeTruthy());
    shouldThrow = false;
    await fireEvent.press(screen.getByTestId('crash-retry'));
    await waitFor(() => expect(screen.queryByTestId('crash-retry')).toBeNull());
  } finally {
    consoleError.mockRestore();
  }
});
