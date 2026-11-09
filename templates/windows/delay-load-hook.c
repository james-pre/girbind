// Loads Node-API from the running executable, so addons work when node.exe is renamed, as in a single executable application.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI loadExecutable(unsigned event, PDelayLoadInfo info) {
	if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe")) return NULL;
	return (FARPROC)GetModuleHandleA(NULL);
}

PfnDliHook __pfnDliNotifyHook2 = loadExecutable;
