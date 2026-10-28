//! "Export Preview as PDF…": render the calling window's webview straight to a
//! PDF file through each OS WebView's own print engine — no print dialog.
//!
//! The page is laid out with print media, so the `@media print` rules in
//! src/styles.css (hide tabs/editor/status bar, paper-width text column) shape
//! the PDF exactly as they shape Print Preview. The frontend checks that a
//! preview is open and picks the path (src/preview.ts `exportPreviewPdf`).
//!
//! Every engine reports completion through a callback on the main thread; the
//! callback sends the outcome over a channel this async command waits on.

use std::sync::mpsc::{self, Sender};
use std::time::Duration;

type Outcome = Result<(), String>;

/// Generous: a long document with many Mermaid diagrams still finishes in a few
/// seconds. This only guards against an engine that never calls back.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);

#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Outcome>();
    // with_webview runs the closure on the main thread, where every engine's
    // print API must be called.
    window
        .with_webview(move |webview| {
            if let Err(err) = platform::print_to_pdf(&webview, &path, tx.clone()) {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(EXPORT_TIMEOUT) {
        Ok(outcome) => outcome,
        Err(_) => Err("PDF export timed out".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

// MARK: - macOS (WKWebView + NSPrintOperation)

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
    };
    use objc2_foundation::{NSString, NSURL};
    use objc2_web_kit::WKWebView;

    use super::{Outcome, Sender};

    /// Paper margins in points (0.5in) — close to what browsers use for
    /// "Save as PDF", instead of NSPrintInfo's 1in default.
    const MARGIN: f64 = 36.0;

    pub struct DelegateIvars {
        tx: RefCell<Option<Sender<Outcome>>>,
    }

    define_class!(
        /// Receives `printOperationDidRun:success:contextInfo:` once the save
        /// job finishes and forwards the result to the waiting command.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "UniNotepadPdfExportDelegate"]
        #[ivars = DelegateIvars]
        struct PdfDelegate;

        impl PdfDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _op: &NSPrintOperation, success: Bool, _ctx: *mut c_void) {
                let outcome = if success.as_bool() {
                    Ok(())
                } else {
                    Err("The print system could not write the PDF".into())
                };
                if let Some(tx) = self.ivars().tx.borrow_mut().take() {
                    let _ = tx.send(outcome);
                }
            }
        }
    );

    impl PdfDelegate {
        fn new(mtm: MainThreadMarker, tx: Sender<Outcome>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(DelegateIvars {
                tx: RefCell::new(Some(tx)),
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        // NOTE: NSPrintOperation does not retain its modal delegate, so the
        // last one is parked here until the next export replaces it. Releasing
        // it from inside its own callback would free `self` mid-method.
        static LAST_DELEGATE: RefCell<Option<Retained<PdfDelegate>>> = const { RefCell::new(None) };
    }

    pub fn print_to_pdf(
        webview: &tauri::webview::PlatformWebview,
        path: &str,
        tx: Sender<Outcome>,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("PDF export must run on the main thread")?;
        // SAFETY: tauri hands out the live WKWebView backing this window.
        let wk: &WKWebView = unsafe { &*(webview.inner() as *const WKWebView) };
        let window = wk.window().ok_or("The preview window is not on screen")?;

        // A fresh NSPrintInfo, not sharedPrintInfo(): the save disposition must
        // not leak into the next Print Preview dialog.
        let info = NSPrintInfo::init(NSPrintInfo::alloc());
        info.setJobDisposition(unsafe { NSPrintSaveJob });
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        unsafe {
            let key: &NSString = NSPrintJobSavingURL;
            let value: &AnyObject = &url;
            info.dictionary()
                .setObject_forKey(value, ProtocolObject::from_ref(key));
        }
        info.setTopMargin(MARGIN);
        info.setBottomMargin(MARGIN);
        info.setLeftMargin(MARGIN);
        info.setRightMargin(MARGIN);

        let op = unsafe { wk.printOperationWithPrintInfo(&info) };
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        // IMPORTANT: WKWebView's print view starts with a zero frame; without a
        // real size every page comes out blank.
        if let Some(view) = op.view() {
            view.setFrame(wk.bounds());
        }

        let delegate = PdfDelegate::new(mtm, tx);
        // The modal (sheet-style) run is required: a synchronous runOperation()
        // on a WKWebView print operation also produces blank pages.
        unsafe {
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        LAST_DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));
        Ok(())
    }
}

// MARK: - Windows (WebView2 PrintToPdf)

#[cfg(windows)]
mod platform {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2PrintSettings, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    use super::{Outcome, Sender};

    pub fn print_to_pdf(
        webview: &tauri::webview::PlatformWebview,
        path: &str,
        tx: Sender<Outcome>,
    ) -> Result<(), String> {
        let core = unsafe { webview.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
        // PrintToPdf needs WebView2 runtime 1.0.1020+ (ICoreWebView2_7) —
        // evergreen installs have it, so a failed cast means a broken runtime.
        let core7: ICoreWebView2_7 = core
            .cast()
            .map_err(|_| "This WebView2 runtime does not support PDF export".to_string())?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            let outcome = match result {
                Err(e) => Err(e.to_string()),
                Ok(()) if !ok => Err("WebView2 could not write the PDF".into()),
                Ok(()) => Ok(()),
            };
            let _ = tx.send(outcome);
            Ok(())
        }));
        // Default settings: portrait, no header/footer, backgrounds off —
        // the same defaults as a browser's "Save as PDF".
        unsafe {
            core7.PrintToPdf(&HSTRING::from(path), None::<&ICoreWebView2PrintSettings>, &handler)
        }
        .map_err(|e| e.to_string())
    }
}

// MARK: - Linux (WebKitGTK PrintOperation → GTK "Print to File")

#[cfg(target_os = "linux")]
mod platform {
    use std::cell::RefCell;
    use std::rc::Rc;

    use webkit2gtk::{PrintOperation, PrintOperationExt};

    use super::{Outcome, Sender};

    pub fn print_to_pdf(
        webview: &tauri::webview::PlatformWebview,
        path: &str,
        tx: Sender<Outcome>,
    ) -> Result<(), String> {
        let uri = gtk::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
        let settings = gtk::PrintSettings::new();
        // GTK's built-in file backend; present wherever GTK's print support is.
        settings.set_printer("Print to File");
        settings.set("output-file-format", Some("pdf"));
        settings.set("output-uri", Some(uri.as_str()));

        let op = PrintOperation::new(&webview.inner());
        op.set_print_settings(&settings);
        // `failed` fires before `finished`, so whichever reports first wins.
        let tx = Rc::new(RefCell::new(Some(tx)));
        let on_failed = tx.clone();
        op.connect_failed(move |_, err| {
            if let Some(tx) = on_failed.borrow_mut().take() {
                let _ = tx.send(Err(err.to_string()));
            }
        });
        op.connect_finished(move |_| {
            if let Some(tx) = tx.borrow_mut().take() {
                let _ = tx.send(Ok(()));
            }
        });
        op.print();
        Ok(())
    }
}
