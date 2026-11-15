use std::path::PathBuf;

use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSEvent, NSEventType, NSImage, NSWindow,
};
use objc2_foundation::{
    NSData, NSMutableArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSString, NSURL,
};

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "FilepaceDraggingSource"]
    #[ivars = Box<dyn Fn()>]
    struct FileSource;

    unsafe impl NSObjectProtocol for FileSource {}

    unsafe impl NSDraggingSource for FileSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operations(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
            // AppKit filters this mask as Option is pressed/released during the
            // drag. The destination (Finder) performs the filesystem operation.
            // Copy must stay allowed for Wry's asynchronous Filepace drop bridge.
            NSDragOperation::Move | NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, _operation: NSDragOperation) {
            // Never remove source files based only on a drag completion signal.
            // Finder moves file URLs itself; internal drops use our task engine.
            (self.ivars())();
        }
    }
);

pub(super) fn start(
    window: &tauri::Window,
    paths: Vec<PathBuf>,
    image: drag::Image,
    finished: impl Fn() + 'static,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("拖放必须在主线程启动")?;
    let raw = window.ns_window().map_err(|error| error.to_string())?;
    let window = unsafe { &*raw.cast::<NSWindow>() };
    let view = window.contentView().ok_or("找不到拖放窗口")?;
    let position = window.mouseLocationOutsideOfEventStream();
    let bytes = match image {
        drag::Image::Raw(bytes) => bytes,
        drag::Image::File(path) => std::fs::read(path).map_err(|error| error.to_string())?,
    };
    let image = NSImage::initWithData(NSImage::alloc(), &NSData::from_vec(bytes))
        .ok_or("无法创建拖放图像")?;
    let size = image.size();
    let frame = NSRect::new(
        NSPoint::new(
            position.x - size.width / 2.0,
            position.y - size.height / 2.0,
        ),
        size,
    );
    let items = NSMutableArray::new();
    for path in paths {
        let url = NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&path.to_string_lossy()),
            path.is_dir(),
        );
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            &ProtocolObject::from_retained(url),
        );
        unsafe { item.setDraggingFrame_contents(frame, Some(&*image)) };
        items.addObject(&*item);
    }
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged, position, NSEvent::modifierFlags_class(),
        NSApp(mtm).currentEvent().map_or(0.0, |event| event.timestamp()),
        window.windowNumber(), None, 0, 1, 1.0,
    ).ok_or("无法创建拖放事件")?;
    let source = FileSource::alloc(mtm).set_ivars(Box::new(finished) as Box<dyn Fn()>);
    let source: Retained<FileSource> = unsafe { msg_send![super(source), init] };
    view.beginDraggingSessionWithItems_event_source(
        &items,
        &event,
        &ProtocolObject::<dyn NSDraggingSource>::from_retained(source),
    );
    Ok(())
}
