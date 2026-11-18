import { fireEvent, render } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';

import TrashScreen from '@/app/trash';
import { makeStoredBookmark as mockMakeStoredBookmark } from './helpers/fake-repository';

const mockEmptyTrash = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, canGoBack: mockCanGoBack }),
}));
jest.mock('@/store/bookmarks', () => ({
  useBookmarks: () => ({
    trash: [mockMakeStoredBookmark({ id: 'discarded', title: 'Discarded bookmark' })],
    emptyTrash: mockEmptyTrash,
    restoreBookmark: jest.fn(),
  }),
}));

const platformOS = Object.getOwnPropertyDescriptor(Platform, 'OS')!;

afterEach(() => {
  Object.defineProperty(Platform, 'OS', platformOS);
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('Empty Trash on web waits for confirmation and supports opening Trash directly', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
  const confirm = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm } });

  try {
    const screen = await render(<TrashScreen />);
    const button = screen.getByRole('button', { name: 'Empty Trash' });
    await fireEvent.press(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('permanently deletes'));
    expect(mockEmptyTrash).not.toHaveBeenCalled();

    mockCanGoBack.mockReturnValue(false);
    await fireEvent.press(button);
    expect(mockEmptyTrash).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('Empty Trash on native waits for the destructive alert action', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockCanGoBack.mockReturnValue(true);

  const screen = await render(<TrashScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Empty Trash' }));
  expect(mockEmptyTrash).not.toHaveBeenCalled();
  const actions = alert.mock.calls[0]?.[2];
  expect(actions?.[0]).toMatchObject({ style: 'cancel' });
  actions?.find((button) => button.style === 'destructive')?.onPress?.();
  expect(mockEmptyTrash).toHaveBeenCalledTimes(1);
  expect(mockBack).toHaveBeenCalledTimes(1);
});
