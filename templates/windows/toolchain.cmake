# Builds Windows addons with MinGW, against the MSYS2 packages in GIRBIND_SYSROOT.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(CMAKE_C_COMPILER ${GIRBIND_MINGW}gcc)
set(CMAKE_CXX_COMPILER ${GIRBIND_MINGW}g++)
set(CMAKE_RC_COMPILER ${GIRBIND_MINGW}windres)

set(CMAKE_FIND_ROOT_PATH "${GIRBIND_SYSROOT}/ucrt64")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

# Addons carry their own C++ runtime instead of using the one that comes with the MSYS2 libraries.
set(CMAKE_SHARED_LINKER_FLAGS_INIT "-L${GIRBIND_SYSROOT}/ucrt64/lib -static-libgcc -static-libstdc++ -s")
