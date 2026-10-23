cmake_minimum_required(VERSION 3.15)
project(girbind)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_compile_definitions(
	NAPI_VERSION=10
	NODE_ADDON_API_CPP_EXCEPTIONS
	NODE_ADDON_API_CPP_EXCEPTIONS_ALL
	GLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_66
	GLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_66
)

execute_process(
	COMMAND node -p "require('node-addon-api').include_dir"
	WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
	OUTPUT_VARIABLE NODE_ADDON_API_DIR
	OUTPUT_STRIP_TRAILING_WHITESPACE
)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED glib-2.0>=2.66 gobject-2.0>=2.66)

set(GIRBIND_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/dist" CACHE PATH "Directory for the built girbind.node")
set(GIRBIND_OUTPUT_NAME "girbind" CACHE STRING "File name of the built addon, without .node; prebuilds use girbind.<platform>-<arch>")

add_library(girbind_runtime SHARED native/runtime.cxx ${CMAKE_JS_SRC})
set_target_properties(girbind_runtime PROPERTIES
	OUTPUT_NAME "${GIRBIND_OUTPUT_NAME}"
	PREFIX ""
	SUFFIX ".node"
	LIBRARY_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"
	RUNTIME_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"
)
target_include_directories(girbind_runtime PRIVATE
	${CMAKE_SOURCE_DIR}/include ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} ${GLIB_INCLUDE_DIRS})
target_link_libraries(girbind_runtime PRIVATE ${CMAKE_JS_LIB} ${GLIB_LIBRARIES})
target_compile_features(girbind_runtime PRIVATE cxx_std_20)
target_compile_options(girbind_runtime PRIVATE "-ffile-prefix-map=${CMAKE_SOURCE_DIR}=.")
target_link_options(girbind_runtime PRIVATE -Wl,--build-id=sha1 -s)
