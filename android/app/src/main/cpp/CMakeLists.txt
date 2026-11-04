cmake_minimum_required(VERSION 3.22.1)
project(opus_jni LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_subdirectory(libopus)

add_library(opus_jni SHARED
    opus_jni.c
)

find_library(log-lib log)

target_include_directories(opus_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/libopus/include
    ${CMAKE_CURRENT_SOURCE_DIR}/libopus/celt
    ${CMAKE_CURRENT_SOURCE_DIR}/libopus/silk
    ${CMAKE_CURRENT_SOURCE_DIR}/libopus/silk/float
    ${CMAKE_CURRENT_SOURCE_DIR}/libopus/silk/fixed
)

target_link_libraries(opus_jni PRIVATE opus ${log-lib})
