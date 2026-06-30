cmake_minimum_required(VERSION 3.15)
project(@PROJECT_NAME@)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_compile_definitions(NAPI_VERSION=10)

add_definitions(
	-DNODE_ADDON_API_CPP_EXCEPTIONS
	-DNODE_ADDON_API_CPP_EXCEPTIONS_ALL
)

# node-addon-api ships napi.h; ask it for its include directory.
execute_process(
	COMMAND node -p "require('node-addon-api').include_dir"
	WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
	OUTPUT_VARIABLE NODE_ADDON_API_DIR
	OUTPUT_STRIP_TRAILING_WHITESPACE
)

find_package(PkgConfig REQUIRED)
# @PKGCONFIG_MODULES@ is filled in by girbind from girbindDependencies
pkg_check_modules(GIRBIND_DEPS REQUIRED @PKGCONFIG_MODULES@)

# Where the built .node is placed. Defaults to the value baked in at `generate`
# time; `girbind build` overrides it with -DGIRBIND_OUTPUT_DIR=<dir>.
set(GIRBIND_OUTPUT_DIR "@OUTPUT_DIR@" CACHE PATH "Directory for the built .node")

file(GLOB SRC "@SRC_DIR@/*.cc")

# The target is named distinctly from the addon (OUTPUT_NAME) so it never
# collides with a linked library of the same name (e.g. linking `flatpak` from
# an addon also called `flatpak` makes CMake think the target links to itself).
set(ADDON_TARGET @PROJECT_NAME@_addon)
add_library(${ADDON_TARGET} SHARED ${SRC} ${CMAKE_JS_SRC})
set_target_properties(${ADDON_TARGET} PROPERTIES
	OUTPUT_NAME "@PROJECT_NAME@"
	PREFIX ""
	SUFFIX ".node"
	LIBRARY_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"
	RUNTIME_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"
)
target_include_directories(${ADDON_TARGET} PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_include_directories(${ADDON_TARGET} PRIVATE ${GIRBIND_DEPS_INCLUDE_DIRS})
target_link_libraries(${ADDON_TARGET} PRIVATE ${CMAKE_JS_LIB} ${GIRBIND_DEPS_LIBRARIES})
target_compile_features(${ADDON_TARGET} PRIVATE cxx_std_23)
