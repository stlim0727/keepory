import { fireEvent, render } from '@testing-library/react-native';
import { ImageViewerModal } from '@/ui/ImageViewerModal';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({ status: 'anonymous', session: null, userId: 'test-user' }),
}));

describe('ImageViewerModal', () => {
  it('renders modal when visible and uri is provided', async () => {
    const screen = await render(
      <ImageViewerModal
        visible={true}
        uri="file:///test-photo.jpg"
        title="Photo caption"
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('bookmark-detail-image-viewer')).toBeTruthy();
    expect(screen.getByTestId('bookmark-detail-viewer-image')).toBeTruthy();
    expect(screen.getByText('Photo caption')).toBeTruthy();
  });

  it('does not render when uri is not provided', async () => {
    const screen = await render(
      <ImageViewerModal
        visible={true}
        uri={null}
        title="Photo caption"
        onClose={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('bookmark-detail-image-viewer')).toBeNull();
  });

  it('calls onClose when close button is pressed', async () => {
    const onClose = jest.fn();
    const screen = await render(
      <ImageViewerModal
        visible={true}
        uri="file:///test-photo.jpg"
        onClose={onClose}
      />,
    );

    fireEvent.press(screen.getByTestId('bookmark-detail-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is pressed', async () => {
    const onClose = jest.fn();
    const screen = await render(
      <ImageViewerModal
        visible={true}
        uri="file:///test-photo.jpg"
        onClose={onClose}
      />,
    );

    fireEvent.press(screen.getByTestId('bookmark-detail-viewer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onShare when share button is pressed', async () => {
    const onShare = jest.fn();
    const screen = await render(
      <ImageViewerModal
        visible={true}
        uri="file:///test-photo.jpg"
        onClose={jest.fn()}
        onShare={onShare}
      />,
    );

    fireEvent.press(screen.getByTestId('bookmark-detail-viewer-share'));
    expect(onShare).toHaveBeenCalledTimes(1);
  });
});
