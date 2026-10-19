ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
const apps=ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier('io.opencodex.desktop'));
const results=[];
for(const app of apps){
 const pid=Number(app.processIdentifier);
 const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll,$.kCGNullWindowID))).filter(w=>w.kCGWindowOwnerPID===pid).map(w=>({id:w.kCGWindowNumber,title:w.kCGWindowName,onScreen:w.kCGWindowIsOnscreen,bounds:w.kCGWindowBounds,layer:w.kCGWindowLayer}));
 results.push({pid,active:Boolean(app.active),hidden:Boolean(app.hidden),windows});
}
JSON.stringify(results);
